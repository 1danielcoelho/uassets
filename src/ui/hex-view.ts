import type { ParseResult, Options, ByteRange } from "../types.ts";
import {
  colorForByte, escHtml, buildActiveRanges,
  type ColoredRange, type HexViewHandle, type HoverRange,
} from "./utils.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

export const ROW_HEIGHT = 20; // px — must match .hex-row height in CSS
const OVERSCAN = 30;          // extra rows rendered above/below the viewport

const BYTE_CELL_W  = 19;  // px — must match .b width in CSS
const BYTE_GAP_W   = 2;   // px — gap in .bytes flex container
const MID_GAP_W    = 6;   // px — extra gap after 8th byte (.b.mid margin-right)
const ASCII_CELL_W = 8;   // px — must match .c width in CSS
const ADDR_COL_W   = 82;  // px — must match .addr width in CSS

// ── Row HTML builder ──────────────────────────────────────────────────────────

function rowHtml(
  rowIndex: number,
  bytes: Uint8Array,
  colorMap: ColoredRange[],
  bytesPerRow: number,
): string {
  const rowStart = rowIndex * bytesPerRow;
  const rowEnd   = Math.min(rowStart + bytesPerRow, bytes.length);
  const addr     = "0x" + rowStart.toString(16).padStart(8, "0");
  const half     = bytesPerRow >>> 1;

  let hexPart   = "";
  let asciiPart = "";

  // Track the current colored range across columns to avoid one binary search per byte.
  // We only re-query when the current offset exits the cached range.
  let cr: ReturnType<typeof colorForByte> = null;

  for (let col = 0; col < bytesPerRow; col++) {
    const offset = rowStart + col;
    const inFile = offset < rowEnd;
    if (inFile && (!cr || offset >= cr.end)) {
      cr = colorForByte(offset, colorMap);
    } else if (!inFile) {
      cr = null;
    }
    const rAttr  = cr ? ` data-byteoffset="${cr.start}"` : "";
    const midCls = col === half - 1 ? " mid" : "";

    if (inFile) {
      const byte = bytes[offset]!;
      const hex  = byte.toString(16).padStart(2, "0").toUpperCase();
      const chr  = (byte >= 32 && byte < 127) ? escHtml(String.fromCharCode(byte)) : "·";

      if (cr) {
        const hexShadow = `;box-shadow:2px 0 0 ${cr.color}`;
        const hexBg = ` style="background:${cr.color};border-radius:0px${hexShadow}"`;
        const asciiBg = ` style="background:${cr.color};border-radius:0px"`;

        hexPart   += `<span class="b${midCls}"${rAttr}${hexBg}>${hex}</span>`;
        asciiPart += `<span class="c"${rAttr}${asciiBg}>${chr}</span>`;
      } else {
        hexPart   += `<span class="b${midCls}"${rAttr}>${hex}</span>`;
        asciiPart += `<span class="c"${rAttr}>${chr}</span>`;
      }
    } else {
      hexPart   += `<span class="b${midCls}">  </span>`;
      asciiPart += `<span class="c"> </span>`;
    }
  }

  return (
    `<div class="hex-row">` +
    `<span class="addr">${addr}</span>` +
    `<span class="bytes">${hexPart}</span>` +
    `<span class="ascii">${asciiPart}</span>` +
    `</div>`
  );
}

// ── Virtual scroll ────────────────────────────────────────────────────────────

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

  const fileBytesArray = new Uint8Array(fileBytes);
  let colorMap: ColoredRange[] = buildActiveRanges(parsedAsset.ranges, new Set<ByteRange>());
  const bytesPerRow = options.bytesPerRow;
  const totalRows = Math.ceil(parsedAsset.totalBytes / bytesPerRow);
  const totalHeight = totalRows * ROW_HEIGHT;

  // ── Column header ─────────────────────────────────────────────────────────
  const bytesColWidth = bytesPerRow * BYTE_CELL_W + (bytesPerRow - 1) * BYTE_GAP_W + MID_GAP_W;
  const asciiColWidth = bytesPerRow * ASCII_CELL_W;
  headerEl.innerHTML =
    `<span style="width:${ADDR_COL_W}px">Address</span>` +
    `<span style="width:${bytesColWidth}px">Bytes (raw)</span>` +
    `<span style="width:${asciiColWidth}px">Bytes (ASCII)</span>`;

  // ── DOM structure ────────────────────────────────────────────────────────
  container.innerHTML = "";

  const spacer = document.createElement("div");
  spacer.style.cssText = `height:${totalHeight}px;position:relative;`;
  container.appendChild(spacer);

  const rowsEl = document.createElement("div");
  rowsEl.style.cssText = "position:absolute;left:0;right:0;";
  spacer.appendChild(rowsEl);

  // ── Hover state ──────────────────────────────────────────────────────────
  let hoveredRange: HoverRange | null = null;
  let lastHoveredEls: HTMLElement[] = [];

  function applyHoveredClass(): void {
    for (const el of lastHoveredEls) el.classList.remove("hovered");
    lastHoveredEls = [];
    if (hoveredRange !== null) {
      const { start, end } = hoveredRange;
      // Collect all colorMap entries that overlap [start, end) — this covers
      // both single ranges and groups whose children share the same overall span.
      for (const cr of colorMap) {
        if (cr.start >= end) break;
        if (cr.end > start) {
          lastHoveredEls.push(
            ...Array.from(rowsEl.querySelectorAll<HTMLElement>(`[data-byteoffset="${cr.start}"]`))
          );
        }
      }
      for (const el of lastHoveredEls) el.classList.add("hovered");
    }
  }

  // ── Render window ────────────────────────────────────────────────────────
  let renderedFirstRow   = -1;
  let renderedMapVersion = -1;
  let mapVersion         = 0;

  function renderWindow(): void {
    const scrollTop    = container.scrollTop;
    const viewportRows = Math.ceil(Math.max(container.clientHeight, 400) / ROW_HEIGHT);
    const firstRow     = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);

    if (firstRow === renderedFirstRow && mapVersion === renderedMapVersion) return;
    renderedFirstRow   = firstRow;
    renderedMapVersion = mapVersion;

    const lastRow = Math.min(totalRows, firstRow + viewportRows + OVERSCAN * 2);
    rowsEl.style.top = `${firstRow * ROW_HEIGHT}px`;

    let html = "";
    for (let r = firstRow; r < lastRow; r++) {
      html += rowHtml(r, fileBytesArray, colorMap, bytesPerRow);
    }
    rowsEl.innerHTML = html;
    lastHoveredEls = []; // stale refs after DOM rebuild
    applyHoveredClass();
  }

  container.addEventListener("scroll", renderWindow, { passive: true, signal });
  renderWindow();

  // ── Hover event handlers ─────────────────────────────────────────────────
  container.addEventListener("mouseover", (e) => {
    const target = e.target as HTMLElement;
    let offsetStr: string | null;

    if (target.classList.contains("b") || target.classList.contains("c")) {
      offsetStr = target.getAttribute("data-byteoffset");
    } else if (
      target === container || target === spacer || target === rowsEl ||
      target.classList.contains("hex-row") || target.classList.contains("addr")
    ) {
      offsetStr = null;
    } else {
      return; // inter-byte gap — keep current
    }

    const cr = offsetStr !== null ? colorForByte(Number(offsetStr), colorMap) : null;
    const newRange = cr ? { start: cr.start, end: cr.end } : null;
    if (newRange?.start === hoveredRange?.start) return;
    hoveredRange = newRange;
    applyHoveredClass();
    handle.onHoverChange?.(hoveredRange);
  }, { signal });

  container.addEventListener("mouseleave", () => {
    if (hoveredRange === null) return;
    hoveredRange = null;
    applyHoveredClass();
    handle.onHoverChange?.(null);
  }, { signal });

  // ── Click handler — notify on any annotated byte click ────────────────────
  container.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("b") && !target.classList.contains("c")) return;
    const offsetStr = target.getAttribute("data-byteoffset");
    if (offsetStr === null) return;
    const cr = colorForByte(Number(offsetStr), colorMap);
    if (!cr) return;
    handle.onClickRange?.(cr.range);
  }, { signal });

  // ── Handle ───────────────────────────────────────────────────────────────
  const handle: HexViewHandle = {
    onHoverChange: null,
    onClickRange: null,

    updateColorMap(ranges: ColoredRange[]): void {
      colorMap = ranges;
      mapVersion++;
      renderWindow();
    },

    setHovered(range: HoverRange | null): void {
      hoveredRange = range;
      applyHoveredClass();
    },

    scrollToOffset(offset: number): void {
      const rowTop    = Math.floor(offset / bytesPerRow) * ROW_HEIGHT;
      const rowBottom = rowTop + ROW_HEIGHT;
      const viewTop    = container.scrollTop;
      const viewBottom = viewTop + container.clientHeight;
      if (rowTop >= viewTop && rowBottom <= viewBottom) return;
      const centeredTop = rowTop - Math.floor((container.clientHeight - ROW_HEIGHT) / 2);
      container.scrollTo({ top: Math.max(0, centeredTop), behavior: "smooth" });
    },
  };

  return handle;
}
