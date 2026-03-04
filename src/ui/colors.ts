// ── Shared color utilities ────────────────────────────────────────────────────

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

/** A range entry that the hex view uses to color bytes. */
export interface ActiveRange {
  start: number;
  end: number;
  label: string;
}
