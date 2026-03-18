// ─── Byte range annotation ──────────────────────────────────────────────────

import type { FGuid } from "./parser/types.ts";

interface ByteRangeBase {
  /** Byte offset in the file, inclusive. */
  start: number;
  /** Byte offset in the file, exclusive. */
  end: number;
  /** Short label shown in the legend, e.g. "Engine Version". */
  label: string;
}

export type ByteRange = ByteRangeBase & (
  | { kind: "int8" | "int16" | "int32" | "uint8" | "uint16" | "uint32"
            | "float32" | "float64";  value: number; display?: string }
  | { kind: "int64" | "uint64";       value: bigint; display?: string }
  | { kind: "bytes";                  value: Uint8Array }
  | { kind: "string";                 value: string }
  | { kind: "guid";                   value: FGuid }
  | { kind: "group";                  value?: unknown; children: ByteRange[] }
);

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
  /** Total number of entries in the package name table. */
  nameCount: number;
  /** Resolved export table entries. */
  exports: Array<{
    index: number;
    objectName: string;
    className: string;
    serialOffset: number;
    serialSize: number;
    isAsset: boolean;
  }>;
  /** Resolved import table entries. */
  imports: Array<{
    index: number;
    classPackage: string;
    className: string;
    objectName: string;
  }>;
  /** Primary thumbnail image, if present in the asset. */
  thumbnail?: {
    width: number;
    height: number;
    mimeType: "image/jpeg" | "image/png";
    data: Uint8Array;
  };
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
