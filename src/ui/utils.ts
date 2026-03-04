import type { ByteRange } from "../types.ts";
import { fGuidToString } from "../parser/utils.ts";

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
      result.push(...buildActiveRanges(range.children, expandedRanges));
    } else {
      result.push({ start: range.start, end: range.end, color: colorForLabel(range.label), range });
    }
  }
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

export interface ViewerHandle {
  setHovered(start: number | null): void;
  onHoverChange: ((start: number | null) => void) | null;
}

export interface HexViewHandle extends ViewerHandle {
  updateColorMap(ranges: ColoredRange[]): void;
  onClickRange: ((range: ByteRange) => void) | null;
}

// ── Formatters ────────────────────────────────────────────────────────────────

/** SI-prefixed byte count. Append "B" at call site for full units (e.g. "4.2 M" + "B" → "4.2 MB"). */
export function formatSize(n: number): string {
  if (n < 1_000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)} K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  return `${(n / 1_000_000_000).toFixed(2)} G`;
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
