import type { ParseResult, Options, ByteRange } from "../types.ts";
import {
  colorForByte, buildActiveRanges,
  type ColoredRange, type HexViewHandle, type HoverRange,
} from "./utils.ts";

// ── Layout constants ───────────────────────────────────────────────────────────
// These must remain consistent with app.ts's hexColumnWidth() call.

export const ROW_HEIGHT = 20;       // px per row
const FONT_SIZE    = 12;            // px
const FONT         = `${FONT_SIZE}px 'Cascadia Code', 'Fira Code', Consolas, monospace`;

const BYTE_CELL_W  = 19;   // width of one hex byte cell
const BYTE_GAP_W   = 2;    // gap between hex byte cells
const MID_GAP_W    = 6;    // extra gap after the 8th cell
const ASCII_CELL_W = 8;    // width of one ASCII char cell
const ADDR_COL_W   = 82;   // address column width
const HEX_ROW_GAP  = 16;   // gap between address/bytes/ascii columns
const HEX_PANEL_H_PAD = 24;

/** Total CSS-px width the #hex-column should be set to. */
export function hexColumnWidth(bytesPerRow: number): number {
  const bytesColWidth = bytesPerRow * BYTE_CELL_W + (bytesPerRow - 1) * BYTE_GAP_W + MID_GAP_W;
  const asciiColWidth = bytesPerRow * ASCII_CELL_W;
  return ADDR_COL_W + HEX_ROW_GAP + bytesColWidth + HEX_ROW_GAP + asciiColWidth + HEX_PANEL_H_PAD;
}

// ── Colors ────────────────────────────────────────────────────────────────────

const CLR_ADDR      = "#555";
const CLR_ADDR_HL   = "#ffffff";   // search-matched address
const CLR_ADDR_ACT  = "#ffee55";   // active search address bg
const CLR_TEXT      = "#c8c8c8";   // normal byte/ascii text
const CLR_TEXT_DARK = "#111";      // text on bright bg
const CLR_SEARCH    = "#ffffff";   // search match fill
const CLR_SEARCH_ACT= "#ffee55";   // active search match fill
const CLR_HOVER_ADD = "rgba(255,255,255,0.12)";  // overlay on hovered bytes
const CLR_HOVER_DIM = "rgba(0,0,0,0.28)";        // overlay on non-hovered annotated bytes

// ── initHexView ───────────────────────────────────────────────────────────────

let currentAbort: AbortController | null = null;

export function initHexView(
  container: HTMLElement,
  headerEl: HTMLElement,
  fileBytes: ArrayBuffer,
  parsedAsset: ParseResult,
  options: Options,
): HexViewHandle {
  currentAbort?.abort();
  currentAbort = new AbortController();
  const { signal } = currentAbort;

  const bytes       = new Uint8Array(fileBytes);
  const bytesPerRow = options.bytesPerRow;
  const half        = bytesPerRow >>> 1;
  const totalRows   = Math.ceil(parsedAsset.totalBytes / bytesPerRow);
  const totalHeight = totalRows * ROW_HEIGHT;

  let colorMap: ColoredRange[] = buildActiveRanges(parsedAsset.ranges, new Set<ByteRange>());

  // ── Search state ──────────────────────────────────────────────────────────
  let smGroups:          ReadonlyArray<{ readonly offsets: ReadonlyArray<number>; readonly len: number }> = [];
  let smActiveStart      = -1;
  let smActiveLen        = 0;
  let smAddrOffsets:     Set<number> = new Set();
  let smActiveAddrOffset             = -1;

  // ── Column layout (CSS px) ────────────────────────────────────────────────
  const bytesColWidth = bytesPerRow * BYTE_CELL_W + (bytesPerRow - 1) * BYTE_GAP_W + MID_GAP_W;
  const asciiColWidth = bytesPerRow * ASCII_CELL_W;
  const hexColX       = ADDR_COL_W + HEX_ROW_GAP;
  const asciiColX     = hexColX + bytesColWidth + HEX_ROW_GAP;

  /** CSS-px x position of the left edge of byte cell `col` within the hex column. */
  function byteX(col: number): number {
    return hexColX + col * (BYTE_CELL_W + BYTE_GAP_W) + (col >= half ? MID_GAP_W : 0);
  }

  // ── Column header ─────────────────────────────────────────────────────────
  headerEl.innerHTML =
    `<span style="width:${ADDR_COL_W}px">Address</span>` +
    `<span style="width:${bytesColWidth}px">Bytes (raw)</span>` +
    `<span style="width:${asciiColWidth}px">Bytes (ASCII)</span>`;

  // ── DOM: spacer containing canvas ────────────────────────────────────────
  // The spacer sets the total scroll height. The canvas lives inside it as a
  // sticky child so it remains glued to the top of #hex-panel's viewport while
  // the user scrolls through the spacer's full height.
  container.innerHTML = "";

  const spacer = document.createElement("div");
  spacer.style.cssText = `height:${totalHeight}px;`;
  container.appendChild(spacer);

  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:sticky;top:0;display:block;cursor:default;";
  spacer.appendChild(canvas);

  const ctx = canvas.getContext("2d")!;

  // ── Canvas sizing ─────────────────────────────────────────────────────────
  let cssW = 0;
  let cssH = 0;
  let canvasRect = canvas.getBoundingClientRect();

  function resizeCanvas(w: number, h: number): void {
    cssW = w; cssH = h;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width  = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = FONT;
    ctx.textBaseline = "middle";
    canvasRect = canvas.getBoundingClientRect();
  }

  const ro = new ResizeObserver(entries => {
    const e = entries[0];
    if (!e) return;
    const { width, height } = e.contentRect;
    resizeCanvas(width, height);
    requestRedraw();
  });
  ro.observe(container);
  signal.addEventListener("abort", () => ro.disconnect());

  // ── RAF scheduler ─────────────────────────────────────────────────────────
  let rafId = 0;
  function requestRedraw(): void {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; drawFrame(); });
  }
  signal.addEventListener("abort", () => { if (rafId) cancelAnimationFrame(rafId); });

  // ── Hover state ───────────────────────────────────────────────────────────
  let hoveredRange: HoverRange | null = null;

  // ── Draw frame ────────────────────────────────────────────────────────────
  function drawFrame(): void {
    if (cssW === 0 || cssH === 0) return;

    const scrollTop  = container.scrollTop;
    const firstRow   = Math.floor(scrollTop / ROW_HEIGHT);
    const visibleRows = Math.ceil(cssH / ROW_HEIGHT) + 1;
    const lastRow    = Math.min(totalRows, firstRow + visibleRows);

    ctx.clearRect(0, 0, cssW, cssH);

    const hasHover = hoveredRange !== null;

    for (let r = firstRow; r < lastRow; r++) {
      const rowStart = r * bytesPerRow;
      const rowEnd   = Math.min(rowStart + bytesPerRow, bytes.length);
      const y        = r * ROW_HEIGHT - scrollTop;
      const textY    = y + ROW_HEIGHT / 2;

      // ── Per-group two-pointer state for search highlights ──────────────
      const ptrs = smGroups.map(g => {
        if (g.len <= 0 || g.offsets.length === 0) return g.offsets.length;
        const minStart = rowStart - g.len + 1;
        let lo = 0, hi = g.offsets.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if ((g.offsets[mid] as number) < minStart) lo = mid + 1; else hi = mid;
        }
        return lo;
      });

      // Track current colored range to avoid repeated binary search
      let cr: ColoredRange | null = null;

      // ── Address column ─────────────────────────────────────────────────
      const addr = "0x" + rowStart.toString(16).padStart(8, "0");
      if (rowStart === smActiveAddrOffset) {
        ctx.fillStyle = CLR_ADDR_ACT;
        ctx.fillRect(0, y, ADDR_COL_W, ROW_HEIGHT);
        ctx.fillStyle = CLR_TEXT_DARK;
      } else if (smAddrOffsets.has(rowStart)) {
        ctx.fillStyle = CLR_ADDR_HL;
        ctx.fillRect(0, y, ADDR_COL_W, ROW_HEIGHT);
        ctx.fillStyle = CLR_TEXT_DARK;
      } else {
        ctx.fillStyle = CLR_ADDR;
      }
      ctx.textAlign = "left";
      ctx.fillText(addr, 0, textY);

      // ── Bytes + ASCII columns ──────────────────────────────────────────
      for (let col = 0; col < bytesPerRow; col++) {
        const offset = rowStart + col;
        const inFile = offset < rowEnd;

        if (inFile && (!cr || offset >= cr.end)) {
          cr = colorForByte(offset, colorMap);
        } else if (!inFile) {
          cr = null;
        }

        // Determine search match state for this byte
        let isMatch = false;
        for (let gi = 0; gi < smGroups.length; gi++) {
          const g = smGroups[gi]!;
          let p = ptrs[gi]!;
          while (p < g.offsets.length && (g.offsets[p] as number) + g.len <= offset) p++;
          ptrs[gi] = p;
          if (p < g.offsets.length && (g.offsets[p] as number) <= offset) isMatch = true;
        }
        const isActive = smActiveStart >= 0 && offset >= smActiveStart && offset < smActiveStart + smActiveLen;

        const bx = byteX(col);
        const ax = asciiColX + col * ASCII_CELL_W;

        if (!inFile) {
          // Empty padding at end of last row — skip
          continue;
        }

        const byte = bytes[offset]!;
        const hexStr = byte.toString(16).padStart(2, "0").toUpperCase();
        const asciiChr = (byte >= 32 && byte < 127) ? String.fromCharCode(byte) : "·";

        // ── Background fills ─────────────────────────────────────────────

        // Hex cell: extend fill by BYTE_GAP_W on right so no gap between same-color cells
        // (matches the old box-shadow trick)
        const hexFillW = BYTE_CELL_W + (col < bytesPerRow - 1 ? BYTE_GAP_W : 0);

        if (isActive) {
          ctx.fillStyle = CLR_SEARCH_ACT;
          ctx.fillRect(bx, y, hexFillW, ROW_HEIGHT);
          ctx.fillRect(ax, y, ASCII_CELL_W, ROW_HEIGHT);
        } else if (isMatch) {
          ctx.fillStyle = CLR_SEARCH;
          ctx.fillRect(bx, y, hexFillW, ROW_HEIGHT);
          ctx.fillRect(ax, y, ASCII_CELL_W, ROW_HEIGHT);
        } else if (cr) {
          ctx.fillStyle = cr.color;
          ctx.fillRect(bx, y, hexFillW, ROW_HEIGHT);
          ctx.fillRect(ax, y, ASCII_CELL_W, ROW_HEIGHT);
        }

        // ── Hover overlay ─────────────────────────────────────────────────
        if (hasHover && cr) {
          const inHover = offset >= hoveredRange!.start && offset < hoveredRange!.end;
          ctx.fillStyle = inHover ? CLR_HOVER_ADD : CLR_HOVER_DIM;
          ctx.fillRect(bx, y, hexFillW, ROW_HEIGHT);
          ctx.fillRect(ax, y, ASCII_CELL_W, ROW_HEIGHT);
        }

        // ── Text ──────────────────────────────────────────────────────────
        const isDark = isActive || isMatch;
        ctx.fillStyle = isDark ? CLR_TEXT_DARK : CLR_TEXT;
        ctx.textAlign = "center";
        ctx.fillText(hexStr,   bx + BYTE_CELL_W / 2, textY);
        ctx.fillText(asciiChr, ax + ASCII_CELL_W / 2, textY);
      }
    }
  }

  // ── Scroll ────────────────────────────────────────────────────────────────
  container.addEventListener("scroll", requestRedraw, { passive: true, signal });

  // ── Hit-test: CSS-px x → byte column index ────────────────────────────────
  function hitTest(mx: number, my: number): number | null {
    const virtualY = container.scrollTop + my;
    const row      = Math.floor(virtualY / ROW_HEIGHT);
    if (row < 0 || row >= totalRows) return null;
    const rowStart = row * bytesPerRow;

    // Hex column — each cell's hit area extends to the start of the next cell
    // so gaps (BYTE_GAP_W, MID_GAP_W) don't create dead zones that flicker hover.
    if (mx >= hexColX && mx < hexColX + bytesColWidth) {
      for (let col = 0; col < bytesPerRow; col++) {
        const bx       = byteX(col);
        const rightEdge = col < bytesPerRow - 1 ? byteX(col + 1) : bx + BYTE_CELL_W;
        if (mx >= bx && mx < rightEdge) {
          const offset = rowStart + col;
          return offset < bytes.length ? offset : null;
        }
      }
      return null;
    }

    // ASCII column
    if (mx >= asciiColX && mx < asciiColX + asciiColWidth) {
      const col    = Math.floor((mx - asciiColX) / ASCII_CELL_W);
      const offset = rowStart + col;
      return (col < bytesPerRow && offset < bytes.length) ? offset : null;
    }

    return null;
  }

  // ── Mouse events ──────────────────────────────────────────────────────────
  canvas.addEventListener("mousemove", (e) => {
    const mx = e.clientX - canvasRect.left;
    const my = e.clientY - canvasRect.top;
    const offset = hitTest(mx, my);
    const cr     = offset !== null ? colorForByte(offset, colorMap) : null;
    const newRange = cr ? { start: cr.start, end: cr.end } : null;

    canvas.style.cursor = cr ? "pointer" : "default";

    if (newRange?.start === hoveredRange?.start) return;
    hoveredRange = newRange;
    requestRedraw();
    handle.onHoverChange?.(hoveredRange);
  }, { signal });

  canvas.addEventListener("mouseleave", () => {
    if (hoveredRange === null) return;
    hoveredRange = null;
    canvas.style.cursor = "default";
    requestRedraw();
    handle.onHoverChange?.(null);
  }, { signal });

  canvas.addEventListener("click", (e) => {
    const offset = hitTest(e.clientX - canvasRect.left, e.clientY - canvasRect.top);
    if (offset === null) return;
    const cr = colorForByte(offset, colorMap);
    if (!cr) return;
    handle.onClickRange?.(cr.range);
  }, { signal });

  canvas.addEventListener("dblclick", (e) => {
    const offset = hitTest(e.clientX - canvasRect.left, e.clientY - canvasRect.top);
    if (offset === null) return;
    const cr = colorForByte(offset, colorMap);
    if (!cr) return;
    handle.onDblClickRange?.(cr.range);
  }, { signal });

  canvas.addEventListener("contextmenu", (e) => {
    const offset = hitTest(e.clientX - canvasRect.left, e.clientY - canvasRect.top);
    if (offset === null) return;
    const cr = colorForByte(offset, colorMap);
    if (!cr) return;
    e.preventDefault();
    handle.onContextMenuRange?.(cr.range, e.clientX, e.clientY);
  }, { signal });

  // ── Handle ────────────────────────────────────────────────────────────────
  const handle: HexViewHandle = {
    onHoverChange:     null,
    onClickRange:      null,
    onDblClickRange:   null,
    onContextMenuRange: null,

    updateColorMap(ranges: ColoredRange[]): void {
      colorMap = ranges;
      requestRedraw();
    },

    setHovered(range: HoverRange | null): void {
      hoveredRange = range;
      requestRedraw();
    },

    setSearchHighlights(
      groups,
      activeByteStart,
      activeByteLen,
      addrOffsets,
      activeAddrOffset,
    ): void {
      smGroups           = groups;
      smActiveStart      = activeByteStart;
      smActiveLen        = activeByteLen;
      smAddrOffsets      = new Set(addrOffsets);
      smActiveAddrOffset = activeAddrOffset;
      requestRedraw();
    },

    scrollToOffset(offset: number): void {
      const rowTop      = Math.floor(offset / bytesPerRow) * ROW_HEIGHT;
      const centeredTop = rowTop - Math.floor((container.clientHeight - ROW_HEIGHT) / 2);
      container.scrollTo({ top: Math.max(0, centeredTop), behavior: "smooth" });
    },
  };

  requestRedraw();
  return handle;
}
