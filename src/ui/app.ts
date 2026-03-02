import type { ByteRange, ParseResult } from "../types.ts";
import { fGuidToString } from "../parser/utils.ts";
import { parseUAsset } from "../parser/parser.ts";

// ── Elements ──────────────────────────────────────────────────────────────────

const hexPanel     = document.getElementById("hex-panel")!;
const summaryPanel = document.getElementById("summary-panel")!;
const menuFile     = document.getElementById("menu-file")!;
const dropdownFile = document.getElementById("dropdown-file")!;
const menuFileOpen = document.getElementById("menu-file-open")!;

// ── File input ────────────────────────────────────────────────────────────────

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = ".uasset,.umap";
document.body.appendChild(fileInput);

// ── Menu wiring ───────────────────────────────────────────────────────────────

menuFile.addEventListener("click", (e) => {
  e.stopPropagation();
  dropdownFile.classList.toggle("open");
});

document.addEventListener("click", () => {
  dropdownFile.classList.remove("open");
});

menuFileOpen.addEventListener("click", () => {
  fileInput.value = "";
  fileInput.click();
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  openFile(file);
});

// ── Drag-and-drop ─────────────────────────────────────────────────────────────

document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (file) openFile(file);
});

// ── Open & parse ──────────────────────────────────────────────────────────────

async function openFile(file: File): Promise<void> {
  const titleEl = document.getElementById("menubar-title")!;
  titleEl.textContent = `Loading ${file.name}…`;

  const buffer = await file.arrayBuffer();
  let result: ParseResult;
  try {
    result = parseUAsset(buffer);
  } catch (err) {
    hexPanel.innerHTML = "";
    const pre = document.createElement("pre");
    pre.style.color = "#f44";
    pre.textContent = `Parse error:\n${err}`;
    hexPanel.appendChild(pre);
    summaryPanel.innerHTML = `<span class="placeholder">Parse failed</span>`;
    titleEl.textContent = `Error — ${file.name}`;
    return;
  }

  titleEl.textContent = file.name;
  renderSummary(result, file);
  renderDump(result);
}

// ── Summary panel ─────────────────────────────────────────────────────────────

function renderSummary(result: ParseResult, file: File): void {
  const { summary, totalBytes } = result;

  const lines: string[] = [];

  const cls  = summary.assetClass || "(unknown class)";
  const path = summary.packageName || file.name;

  summaryPanel.innerHTML = [
    `<div class="asset-class">${escHtml(cls)}</div>`,
    `<div class="asset-path">${escHtml(path)}</div>`,
    metaLine("Engine",  summary.engineVersion || "—"),
    metaLine("Size",    formatBytes(totalBytes)),
    metaLine("Names",   `${summary.nameCount}`),
    metaLine("Exports", `${summary.exports.length}`),
    metaLine("Imports", `${summary.imports.length}`),
    ...summary.properties.map(p => metaLine(p.label, p.value)),
    summary.customVersions.length > 0
      ? metaLine("Custom ver.", `${summary.customVersions.length} entries`)
      : "",
  ].join("");
}

function metaLine(label: string, value: string): string {
  return `<div class="meta-line"><span class="meta-label">${escHtml(label)}: </span>${escHtml(value)}</div>`;
}

// ── Hex panel: range tree dump ────────────────────────────────────────────────

function renderDump(result: ParseResult): void {
  hexPanel.innerHTML = "";
  const pre = document.createElement("pre");
  const lines: string[] = [];
  buildRangeTree(result.ranges, 0, lines);
  pre.textContent = lines.join("\n");
  hexPanel.appendChild(pre);
}

function buildRangeTree(ranges: ByteRange[], depth: number, out: string[]): void {
  const indent = "  ".repeat(depth);
  for (const range of ranges) {
    const offset = `0x${range.start.toString(16).padStart(8, "0")}`;
    const size   = `+${formatBytes(range.end - range.start)}`.padStart(9);
    const label  = (indent + range.label).padEnd(36);
    const val    = stringifyValue(range);
    const valStr = val ? `  →  ${truncate(val, 60)}` : "";
    out.push(`${offset} ${size}  ${label}${valStr}`);
    if (range.kind === "group" && range.children.length > 0) {
      buildRangeTree(range.children, depth + 1, out);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stringifyValue(range: ByteRange): string {
  switch (range.kind) {
    case "int8":  case "int16":  case "int32":
    case "uint8": case "uint16": case "uint32":
    case "float32": case "float64": return range.value.toString();
    case "int64": case "uint64":    return range.value.toString();
    case "bytes":  return Array.from(range.value).map(b => b.toString(16).padStart(2, "0")).join(" ");
    case "string": return `"${range.value}"`;
    case "guid":   return fGuidToString(range.value);
    case "group":  return typeof range.value === "string" ? range.value : "";
  }
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

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
