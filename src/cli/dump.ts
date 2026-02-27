/**
 * CLI tool: parse a .uasset file and dump the ByteRange annotation tree to stdout.
 *
 * Usage:
 *   bun run src/cli/dump.ts path/to/file.uasset [--json]
 *
 * Options:
 *   --json   Output raw JSON instead of the human-readable tree
 */

import { readFileSync } from "fs";
import type { ByteRange, ParseResult } from "../types.ts";
import { fGuidToString } from "../parser/primitives.ts";
import { parseUAsset } from "../parser/summary.ts";

// ── Entry point ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const filePath = args.find(a => !a.startsWith("--"));

if (!filePath) {
  console.error("Usage: bun run src/cli/dump.ts <file.uasset> [--json]");
  process.exit(1);
}

let buffer: ArrayBuffer;
try {
  const bytes = readFileSync(filePath);
  buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
} catch (e) {
  console.error(`Failed to read file: ${filePath}\n${e}`);
  process.exit(1);
}

let result: ParseResult;
try {
  result = parseUAsset(buffer);
} catch (e) {
  console.error(`Parse error: ${e}`);
  process.exit(1);
}

if (jsonMode) {
  console.log(JSON.stringify(result, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
  process.exit(0);
}

// ── Human-readable tree dump ──────────────────────────────────────────────────

const { ranges, totalBytes, summary } = result;

console.log("═".repeat(72));
console.log(`  File: ${filePath}`);
console.log(`  Size: ${formatBytes(totalBytes)}`);
console.log("─".repeat(72));
console.log(`  Asset class : ${summary.assetClass || "(unknown)"}`);
console.log(`  Package     : ${summary.packageName}`);
console.log(`  Engine      : ${summary.engineVersion}`);
if (summary.customVersions.length > 0) {
  console.log(`  Custom vers : ${summary.customVersions.length} entries`);
}
if (summary.properties.length > 0) {
  for (const p of summary.properties) {
    console.log(`  ${p.label.padEnd(12)}: ${p.value}`);
  }
}
console.log("═".repeat(72));
console.log();

// Coverage stats
const annotatedBytes = countAnnotatedBytes(ranges, totalBytes);
const pct = ((annotatedBytes / totalBytes) * 100).toFixed(1);
console.log(`  Annotated: ${formatBytes(annotatedBytes)} of ${formatBytes(totalBytes)} (${pct}%)`);
console.log();

// Range tree
printRangeTree(ranges, 0);

// ── Formatting helpers ────────────────────────────────────────────────────────

function printRangeTree(ranges: ByteRange[], depth: number): void {
  const indent = "  ".repeat(depth);
  for (const range of ranges) {
    const offsetStr = `0x${range.start.toString(16).padStart(8, "0")}`;
    const sizeStr   = `+${formatBytes(range.end - range.start)}`.padStart(9);
    const colorDot  = colorChar(range.label);
    const label     = range.label.padEnd(30 - depth * 2);
    const vs        = stringifyValue(range);
    const value     = vs ? `  →  ${truncate(vs, 50)}` : "";
    console.log(`${indent}${colorDot} ${offsetStr} ${sizeStr}  ${label}${value}`);
    if (range.kind === "group" && range.children.length > 0) {
      printRangeTree(range.children, depth + 1);
    }
  }
}

function stringifyValue(range: ByteRange): string {
  switch (range.kind) {
    case "int8":   case "int16":   case "int32":
    case "uint8":  case "uint16":  case "uint32":
    case "float32": case "float64": return range.value.toString();
    case "int64":  case "uint64":  return range.value.toString();
    case "bytes":   return Array.from(range.value).map(b => b.toString(16).padStart(2, "0")).join("");
    case "string":  return range.value;
    case "guid":    return fGuidToString(range.value);
    case "group":   return "";
  }
}

// ANSI color codes available for label hashing
const ANSI_COLORS = [
  "\x1b[32m", // green
  "\x1b[34m", // blue
  "\x1b[35m", // magenta
  "\x1b[33m", // yellow
  "\x1b[36m", // cyan
  "\x1b[31m", // red
  "\x1b[37m", // white
  "\x1b[90m", // dark gray
];

function colorChar(label: string): string {
  // djb2 hash of the label, pick a color from the palette
  let h = 5381;
  for (let i = 0; i < label.length; i++) h = ((h << 5) + h) ^ label.charCodeAt(i);
  const code = ANSI_COLORS[Math.abs(h) % ANSI_COLORS.length]!;
  return `${code}■\x1b[0m`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function countAnnotatedBytes(ranges: ByteRange[], totalBytes: number): number {
  // Build a simple coverage bitmap using a sorted interval merge
  const intervals: [number, number][] = [];
  collectIntervals(ranges, intervals);
  intervals.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let cur = 0;
  for (const [s, e] of intervals) {
    const start = Math.max(s, cur);
    const end   = Math.min(e, totalBytes);
    if (end > start) {
      covered += end - start;
      cur = end;
    }
  }
  return covered;
}

function collectIntervals(ranges: ByteRange[], out: [number, number][]): void {
  for (const range of ranges) {
    out.push([range.start, range.end]);
    if (range.kind === "group") collectIntervals(range.children, out);
  }
}
