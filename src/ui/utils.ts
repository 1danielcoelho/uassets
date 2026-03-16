import type { ByteRange } from "../types.ts";
import { fGuidToString } from "../parser/utils.ts";

// ── Search ────────────────────────────────────────────────────────────────────

export type SearchMode = "text" | "hex";

/** Returns all byte offsets where `query` starts in `bytes`. */
export function findMatches(
  bytes: Uint8Array,
  query: string,
  mode: SearchMode,
): { offsets: number[]; queryLen: number } {
  if (!query) return { offsets: [], queryLen: 0 };

  let needle: Uint8Array;
  if (mode === "hex") {
    const hexStr = query.replace(/\s+/g, "");
    if (hexStr.length === 0 || hexStr.length % 2 !== 0) {
      return { offsets: [], queryLen: 0 };
    }
    const byteArr: number[] = [];
    for (let i = 0; i < hexStr.length; i += 2) {
      const b = parseInt(hexStr.slice(i, i + 2), 16);
      if (isNaN(b)) return { offsets: [], queryLen: 0 };
      byteArr.push(b);
    }
    needle = new Uint8Array(byteArr);
  } else {
    needle = new TextEncoder().encode(query);
  }

  if (needle.length === 0) return { offsets: [], queryLen: 0 };

  const offsets: number[] = [];
  const n = bytes.length;
  const m = needle.length;
  const first = needle[0]!;

  outer: for (let i = 0; i <= n - m; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < m; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    offsets.push(i);
  }

  return { offsets, queryLen: m };
}

/** Find row start offsets whose hex address string contains the query. */
export function findAddressMatches(totalBytes: number, bytesPerRow: number, query: string): number[] {
  const q = query.toLowerCase().replace(/^0x/, "").replace(/\s+/g, "");
  if (!q) return [];
  const offsets: number[] = [];
  const totalRows = Math.ceil(totalBytes / bytesPerRow);
  for (let r = 0; r < totalRows; r++) {
    const rowOffset = r * bytesPerRow;
    if (rowOffset.toString(16).padStart(8, "0").includes(q)) offsets.push(rowOffset);
  }
  return offsets;
}

/** Case-insensitive search through a range tree's labels and values. */
export function findAnnotationMatches(ranges: ByteRange[], query: string): ByteRange[] {
  const q = query.toLowerCase();
  const result: ByteRange[] = [];
  function walk(range: ByteRange): void {
    if (range.label.toLowerCase().includes(q) || valueStr(range).toLowerCase().includes(q)) {
      result.push(range);
    }
    if (range.kind === "group") for (const child of range.children) walk(child);
  }
  for (const range of ranges) walk(range);
  return result;
}

// ── Color utilities ────────────────────────────────────────────────────────────

/**
 * Produces a stable dark background color for any string label.
 * Uses djb2 hashing to derive a hue, then returns an HSL color with fixed
 * saturation/lightness that keeps hex text (#c8c8c8) readable.
 */
export function colorForLabel(label: string): string {
  let h = 5381;
  for (let i = 0; i < label.length; i++) {
    h = (Math.imul(h, 33) ^ label.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue}, 55%, 22%)`;
}

// ── Range types ───────────────────────────────────────────────────────────────

/** A resolved colored range for hex view rendering. */
export interface ColoredRange {
  start: number;
  end: number;
  color: string;
  /** The original ByteRange this was derived from. */
  range: ByteRange;
}

/** Binary search: find the colored range containing `offset`, or null. */
export function colorForByte(offset: number, map: ColoredRange[]): ColoredRange | null {
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

/** Build a flat list of colored ranges from the range tree, respecting expansion state. */
export function buildActiveRanges(ranges: ByteRange[], expandedRanges: Set<ByteRange>): ColoredRange[] {
  const result: ColoredRange[] = [];
  for (const range of ranges) {
    if (range.kind === "group" && range.children.length > 0 && expandedRanges.has(range)) {
      // Recursive call already returns a sorted list (see sort at end of this function).
      const childRanges = buildActiveRanges(range.children, expandedRanges);
      // Fill any gaps within the parent's span with the parent color so that
      // expanding a group (whose children don't fully cover it due to seek() jumps)
      // never leaves bytes unannotated.
      const parentColor = colorForLabel(range.label);
      let pos = range.start;
      for (const cr of childRanges) {
        if (cr.start > pos) {
          result.push({ start: pos, end: cr.start, color: parentColor, range });
        }
        if (cr.end > pos) {
          result.push(cr);
          pos = cr.end;
        }
      }
      if (pos < range.end) {
        result.push({ start: pos, end: range.end, color: parentColor, range });
      }
    } else {
      result.push({ start: range.start, end: range.end, color: colorForLabel(range.label), range });
    }
  }
  // Sort by file offset so the colorMap is always in order for colorForByte's binary search.
  // The annotation tree can be out of file-offset order when the parser reads a TOC first
  // and then seeks back to an earlier offset to read the data it describes (e.g. thumbnails).
  result.sort((a, b) => a.start - b.start);
  return result;
}

export function removeDescendantsFromExpanded(range: ByteRange, expandedRanges: Set<ByteRange>): void {
  expandedRanges.delete(range);
  if (range.kind === "group") {
    for (const child of range.children) {
      removeDescendantsFromExpanded(child, expandedRanges);
    }
  }
}

// ── Shared handle types ────────────────────────────────────────────────────────

export interface HoverRange {
  start: number;
  end: number;
}

export interface ViewerHandle {
  setHovered(range: HoverRange | null): void;
  onHoverChange: ((range: HoverRange | null) => void) | null;
}

export interface HexViewHandle extends ViewerHandle {
  updateColorMap(ranges: ColoredRange[]): void;
  onClickRange: ((range: ByteRange) => void) | null;
  onDblClickRange: ((range: ByteRange) => void) | null;
  onContextMenuRange: ((range: ByteRange, x: number, y: number) => void) | null;
  scrollToOffset(offset: number): void;
  /**
   * Set all search highlight state at once.
   * groups: one entry per search mode (hex / ascii); activeByteStart = -1 for no active byte match.
   * addrOffsets: row-start offsets to highlight in the address column; activeAddrOffset = -1 for none.
   */
  setSearchHighlights(
    groups: ReadonlyArray<{ readonly offsets: ReadonlyArray<number>; readonly len: number }>,
    activeByteStart: number,
    activeByteLen: number,
    addrOffsets: number[],
    activeAddrOffset: number,
  ): void;
}

// ── Formatters ────────────────────────────────────────────────────────────────

/** SI-prefixed byte count with unit suffix (e.g. "42 B", "4.2 KB", "4.2 MB"). */
export function formatSize(n: number): string {
  if (n < 1_000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)} KB`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${(n / 1_000_000_000).toFixed(2)} GB`;
}

/** Escape HTML special characters for safe insertion into HTML. */
export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Format a ByteRange's value for display in the legend. */
export function valueStr(range: ByteRange): string {
  switch (range.kind) {
    case "int8":  case "int16":  case "int32":
    case "uint8": case "uint16": case "uint32":
    case "float32": case "float64":
      return range.value.toString();
    case "int64": case "uint64":
      return range.value.toString();
    case "bytes": {
      const preview = Array.from(range.value.slice(0, 8))
        .map(b => b.toString(16).padStart(2, "0"))
        .join(" ");
      return range.value.length > 8 ? preview + " …" : preview;
    }
    case "string":
      return range.value.length > 48 ? range.value.slice(0, 47) + "…" : range.value;
    case "guid":
      return fGuidToString(range.value);
    case "group":
      return typeof range.value === "string"
        ? (range.value.length > 48 ? range.value.slice(0, 47) + "…" : range.value)
        : "";
  }
}
