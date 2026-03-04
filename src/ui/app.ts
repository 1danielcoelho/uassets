import type { ParseResult } from "../types.ts";
import { DEFAULT_OPTIONS } from "../types.ts";
import { parseUAsset } from "../parser/parser.ts";
import { initHexView } from "./hex-view.ts";
import { initLegend } from "./legend.ts";

// ── Elements ──────────────────────────────────────────────────────────────────

const hexPanel     = document.getElementById("hex-panel")!;
const hexColHeader = document.getElementById("hex-col-header")!;
const summaryPanel = document.getElementById("summary-panel")!;
const legendPanel  = document.getElementById("legend-panel")!;
const menuFile     = document.getElementById("menu-file")!;
const dropdownFile = document.getElementById("dropdown-file")!;
const menuFileOpen = document.getElementById("menu-file-open")!;
const titleEl      = document.getElementById("menubar-title")!;

// ── File input ────────────────────────────────────────────────────────────────

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = ".uasset,.umap";
fileInput.style.display = "none";
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
  const hexView = initHexView(hexPanel, hexColHeader, buffer, result, DEFAULT_OPTIONS);
  initLegend(legendPanel, result.ranges, hexView.updateColorMap);
}

// ── Summary panel ─────────────────────────────────────────────────────────────

function renderSummary(result: ParseResult, file: File): void {
  const { summary, totalBytes } = result;
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Dev: auto-load test asset ─────────────────────────────────────────────────

fetch("/test/assets/5_7_3/SM_cube.uasset")
  .then(r => r.ok ? r.arrayBuffer() : Promise.reject())
  .then(buf => openFile(new File([buf], "SM_cube.uasset")))
  .catch(() => { /* not in dev, or file missing — silently skip */ });
