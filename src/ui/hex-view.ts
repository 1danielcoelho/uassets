import type { ParseResult, Options } from "../types.ts";
import { colorForLabel, type ActiveRange } from "./colors.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

export const ROW_HEIGHT = 20; // px — must match .hex-row height in CSS
const OVERSCAN = 30;          // extra rows rendered above/below the viewport

// ── Types ─────────────────────────────────────────────────────────────────────

interface ColoredRange {
  start: number;
  end: number;
  color: string;
  idx: number;
}

export interface HexViewHandle {
  updateColorMap(ranges: ActiveRange[]): void;
  setHovered(start: number | null): void;
  onHoverChange: ((start: number | null) => void) | null;
}

// ── Color map ─────────────────────────────────────────────────────────────────

function buildColorMap(ranges: ActiveRange[]): ColoredRange[] {
  return ranges.map((r, i) => ({
    start: r.start,
    end:   r.end,
    color: colorForLabel(r.label),
    idx:   i,
  }));
}

/** Binary search: find the colored range containing `offset`, or null. */
function colorForByte(offset: number, map: ColoredRange[]): ColoredRange | null {
  let lo = 0, hi = map.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = map[mid]!;
    if      (offset < r.start) hi = mid - 1;
    else if (offset >= r.end)  lo = mid + 1;
    else return r;
  }
  return null;
}

// ── Row HTML builder ──────────────────────────────────────────────────────────

function escChr(chr: string): string {
  if (chr === "&") return "&amp;";
  if (chr === "<") return "&lt;";
  if (chr === ">") return "&gt;";
  return chr;
}

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

  // Pre-compute which range covers each column so we can check neighbors cheaply.
  const rowCrs: (ColoredRange | null)[] = new Array(bytesPerRow);
  for (let c = 0; c < bytesPerRow; c++) {
    const off = rowStart + c;
    rowCrs[c] = off < rowEnd ? colorForByte(off, colorMap) : null;
  }

  let hexPart   = "";
  let asciiPart = "";

  for (let col = 0; col < bytesPerRow; col++) {
    const offset = rowStart + col;
    const inFile = offset < rowEnd;
    const cr     = rowCrs[col] ?? null;
    const rAttr  = cr ? ` data-range="${cr.idx}" data-hrange="${cr.start}"` : "";
    const midCls = col === half - 1 ? " mid" : "";

    if (inFile) {
      const byte = bytes[offset]!;
      const hex  = byte.toString(16).padStart(2, "0").toUpperCase();
      const chr  = (byte >= 32 && byte < 127) ? escChr(String.fromCharCode(byte)) : "·";

      if (cr) {
        const prevCr = rowCrs[col - 1] ?? null;
        const nextCr = rowCrs[col + 1] ?? null;
        const prevSame = prevCr?.start === cr.start;
        // The mid-gap (.b.mid has extra margin-right) is a visual break even within
        // the same annotation; treat the byte before it as a run end.
        const nextSame = nextCr?.start === cr.start && col !== half - 1;

        // Apply border-radius only on the "open" (non-connecting) ends of the run.
        // Where the same annotation continues, keep the edge flat so the block looks solid.
        const lR = prevSame ? 0 : 2;
        const rR = nextSame ? 0 : 2;
        const hexRadius = lR === rR ? `${lR}px` : `${lR}px ${rR}px ${rR}px ${lR}px`;
        // Fill the 2px flex gap only when the immediately next byte is the same annotation.
        const hexShadow = nextSame ? `;box-shadow:2px 0 0 ${cr.color}` : "";
        const hexBg = ` style="background:${cr.color};border-radius:${hexRadius}${hexShadow}"`;

        // ASCII has no flex gap so no shadow; apply the same rounding logic independently
        // (no mid-gap concept in ASCII — bytes are always packed tightly).
        const lA = prevSame ? 0 : 1;
        const rA = nextCr?.start === cr.start ? 0 : 1;
        const asciiRadius = lA === rA ? `${lA}px` : `${lA}px ${rA}px ${rA}px ${lA}px`;
        const asciiBg = ` style="background:${cr.color};border-radius:${asciiRadius}"`;

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
  buffer: ArrayBuffer,
  result: ParseResult,
  options: Options,
): HexViewHandle {
  currentAbort?.abort();
  currentAbort = new AbortController();
  const { signal } = currentAbort;

  const bytes       = new Uint8Array(buffer);
  let colorMap      = buildColorMap(result.ranges.map(r => ({ start: r.start, end: r.end, label: r.label })));
  const bytesPerRow = options.bytesPerRow;
  const totalRows   = Math.ceil(result.totalBytes / bytesPerRow);
  const totalHeight = totalRows * ROW_HEIGHT;

  // ── Column header ─────────────────────────────────────────────────────────
  const bytesColWidth = bytesPerRow * 19 + (bytesPerRow - 1) * 2 + 6;
  const asciiColWidth = bytesPerRow * 8;
  headerEl.innerHTML =
    `<span style="width:82px">Address</span>` +
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
  let hoveredHrange: number | null = null;

  function applyHoveredClass(): void {
    for (const el of rowsEl.querySelectorAll<HTMLElement>(".hovered")) {
      el.classList.remove("hovered");
    }
    if (hoveredHrange !== null) {
      for (const el of rowsEl.querySelectorAll<HTMLElement>(`[data-hrange="${hoveredHrange}"]`)) {
        el.classList.add("hovered");
      }
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
      html += rowHtml(r, bytes, colorMap, bytesPerRow);
    }
    rowsEl.innerHTML = html;
    applyHoveredClass();
  }

  container.addEventListener("scroll", renderWindow, { passive: true, signal });
  renderWindow();

  // ── Hover event handlers ─────────────────────────────────────────────────
  container.addEventListener("mouseover", (e) => {
    const target = e.target as HTMLElement;
    let start: number | null;

    if (target.classList.contains("b") || target.classList.contains("c")) {
      // Actual byte / ASCII cell — read its annotation (or clear if unannotated)
      start = target.hasAttribute("data-hrange")
        ? Number(target.getAttribute("data-hrange"))
        : null;
    } else if (
      target === container || target === spacer || target === rowsEl ||
      target.classList.contains("hex-row") || target.classList.contains("addr")
    ) {
      // Clearly "background" (between rows, address column, outer padding) — clear
      start = null;
    } else {
      // Inter-byte flex gaps (.bytes / .ascii containers) — ignore, keep current
      return;
    }

    if (start === hoveredHrange) return;
    hoveredHrange = start;
    applyHoveredClass();
    handle.onHoverChange?.(start);
  }, { signal });

  container.addEventListener("mouseleave", () => {
    if (hoveredHrange === null) return;
    hoveredHrange = null;
    applyHoveredClass();
    handle.onHoverChange?.(null);
  }, { signal });

  // ── Handle ───────────────────────────────────────────────────────────────
  const handle: HexViewHandle = {
    onHoverChange: null,

    updateColorMap(ranges: ActiveRange[]): void {
      colorMap = buildColorMap(ranges);
      mapVersion++;
      renderWindow();
    },

    setHovered(start: number | null): void {
      hoveredHrange = start;
      applyHoveredClass();
    },
  };

  return handle;
}
