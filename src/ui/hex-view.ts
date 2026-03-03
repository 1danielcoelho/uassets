import type { ByteRange, ParseResult, Options } from "../types.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

export const ROW_HEIGHT = 20; // px — must match .hex-row height in CSS
const OVERSCAN = 30;          // extra rows rendered above/below the viewport

// ── Color palette (dark backgrounds, readable with light hex text) ────────────

const PALETTE = [
  "#1c3d5a", // blue
  "#1a4728", // green
  "#4a1f2e", // crimson
  "#3d2c0e", // amber
  "#28184a", // purple
  "#0e3a3a", // teal
  "#4a3a0e", // gold
  "#3a0e3a", // magenta
  "#0e2a4a", // navy
  "#2a4a0e", // lime
  "#4a280e", // rust
  "#0e3a28", // jade
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface ColoredRange {
  start: number;
  end: number;
  color: string;
  idx: number;
}

// ── Color map ─────────────────────────────────────────────────────────────────

/** Assign a palette color to each top-level range. Parser guarantees sorted. */
function buildColorMap(ranges: ByteRange[]): ColoredRange[] {
  return ranges.map((r, i) => ({
    start: r.start,
    end:   r.end,
    color: PALETTE[i % PALETTE.length]!,
    idx:   i,
  }));
}

/** Binary search: top-level range containing `offset`, or null if unannotated. */
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

  let hexPart   = "";
  let asciiPart = "";

  for (let col = 0; col < bytesPerRow; col++) {
    const offset  = rowStart + col;
    const inFile  = offset < rowEnd;
    const cr      = inFile ? colorForByte(offset, colorMap) : null;
    const bgStyle = cr ? ` style="background:${cr.color}"` : "";
    const rAttr   = cr ? ` data-range="${cr.idx}"` : "";
    const midCls  = col === half - 1 ? " mid" : "";

    if (inFile) {
      const byte = bytes[offset]!;
      const hex  = byte.toString(16).padStart(2, "0").toUpperCase();
      const chr  = (byte >= 32 && byte < 127) ? escChr(String.fromCharCode(byte)) : "·";
      hexPart   += `<span class="b${midCls}"${rAttr}${bgStyle}>${hex}</span>`;
      asciiPart += `<span class="c"${rAttr}${bgStyle}>${chr}</span>`;
    } else {
      // Padding for partial last row
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

/** Tear down the previous hex view instance when a new file is opened. */
let currentAbort: AbortController | null = null;

export function initHexView(
  container: HTMLElement,
  headerEl: HTMLElement,
  buffer: ArrayBuffer,
  result: ParseResult,
  options: Options,
): void {
  currentAbort?.abort();
  currentAbort = new AbortController();
  const { signal } = currentAbort;

  const bytes       = new Uint8Array(buffer);
  const colorMap    = buildColorMap(result.ranges);
  const bytesPerRow = options.bytesPerRow;
  const totalRows   = Math.ceil(result.totalBytes / bytesPerRow);
  const totalHeight = totalRows * ROW_HEIGHT;

  // ── Column header (lives outside the scroll area) ─────────────────────────
  const bytesColWidth = bytesPerRow * 19 + (bytesPerRow - 1) * 2 + 6;
  const asciiColWidth = bytesPerRow * 8;
  headerEl.innerHTML =
    `<span style="width:82px">Address</span>` +
    `<span style="width:${bytesColWidth}px">Bytes (raw)</span>` +
    `<span style="width:${asciiColWidth}px">Bytes (ASCII)</span>`;

  // ── DOM structure ────────────────────────────────────────────────────────
  container.innerHTML = "";

  // Spacer establishes the full scroll height
  const spacer = document.createElement("div");
  spacer.style.cssText = `height:${totalHeight}px;position:relative;`;
  container.appendChild(spacer);

  // Rows container is positioned within the spacer to sit at the rendered window
  const rowsEl = document.createElement("div");
  rowsEl.style.cssText = "position:absolute;left:0;right:0;";
  spacer.appendChild(rowsEl);

  // ── Render window ────────────────────────────────────────────────────────
  let renderedFirstRow = -1;

  function renderWindow(): void {
    const scrollTop    = container.scrollTop;
    const viewportRows = Math.ceil(Math.max(container.clientHeight, 400) / ROW_HEIGHT);
    const firstRow     = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);

    if (firstRow === renderedFirstRow) return;
    renderedFirstRow = firstRow;

    const lastRow = Math.min(totalRows, firstRow + viewportRows + OVERSCAN * 2);
    rowsEl.style.top = `${firstRow * ROW_HEIGHT}px`;

    let html = "";
    for (let r = firstRow; r < lastRow; r++) {
      html += rowHtml(r, bytes, colorMap, bytesPerRow);
    }
    rowsEl.innerHTML = html;
  }

  container.addEventListener("scroll", renderWindow, { passive: true, signal });
  renderWindow();
}
