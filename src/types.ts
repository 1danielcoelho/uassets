// ─── Byte range annotation ──────────────────────────────────────────────────

export interface ByteRange {
  /** Byte offset in the file, inclusive. */
  start: number;
  /** Byte offset in the file, exclusive. */
  end: number;
  /** Short label shown in the legend, e.g. "Engine Version". */
  label: string;
  /** Human-readable decoded value, e.g. "5.3.2 (CL 27405482)". */
  value?: string;
  /** Color token. One of the keys in COLORS. */
  color: ColorKey;
  /** Nested ranges (e.g. the sub-fields of FEngineVersion). */
  children?: ByteRange[];
}

// Color palette — add more tokens here as needed.
export const COLORS = {
  magic:        "#4ade80", // green  — file magic / signature
  version:      "#60a5fa", // blue   — version fields
  flags:        "#f472b6", // pink   — flag/enum fields
  offset:       "#fb923c", // orange — offset/count pairs
  string:       "#a78bfa", // purple — FString / FName values
  guid:         "#34d399", // teal   — GUIDs
  customver:    "#fbbf24", // amber  — custom version entries
  export:       "#818cf8", // indigo — export table entries
  import:       "#e879f9", // fuchsia— import table entries
  name:         "#94a3b8", // slate  — names table entries
  bulk:         "#475569", // dark slate — opaque bulk data
  unknown:      "#334155", // darker slate — unparsed regions
} as const;

export type ColorKey = keyof typeof COLORS;

// ─── Parse result ────────────────────────────────────────────────────────────

export interface ParseResult {
  /** Top-level annotated byte ranges, sorted by start offset. */
  ranges: ByteRange[];
  /** Total file size in bytes. */
  totalBytes: number;
  /** High-level asset summary for the summary panel. */
  summary: AssetSummary;
}

export interface AssetSummary {
  /** e.g. "UStaticMesh". Empty string if unknown. */
  assetClass: string;
  /** e.g. "/Game/Characters/Hero/SM_Hero". */
  packageName: string;
  /** e.g. "5.3.2 (CL 27405482)". */
  engineVersion: string;
  customVersions: { name: string; version: number }[];
  /** Asset-specific key/value pairs shown in the summary card. */
  properties: { label: string; value: string }[];
}

// ─── Display segment ─────────────────────────────────────────────────────────

/** A row segment in the hex viewer. Either a block of concrete hex rows, or a
 *  collapsed ellipsis representing a large run of bytes. */
export type DisplaySegment =
  | { type: "rows";     startByte: number; endByte: number }
  | { type: "ellipsis"; startByte: number; endByte: number; label: string };

// ─── Viewer state ────────────────────────────────────────────────────────────

export interface ViewerState {
  scrollTop: number;
  /** The range currently hovered in the hex view or legend. */
  hoveredRange: ByteRange | null;
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface Options {
  /** Number of bytes displayed per hex row. Default: 16. */
  bytesPerRow: number;
  /** Byte spans longer than this with no children are collapsed into an ellipsis. */
  collapseThreshold: number;
}

export const DEFAULT_OPTIONS: Options = {
  bytesPerRow: 16,
  collapseThreshold: 512,
};
