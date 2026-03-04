import type { ParseResult } from "../types.ts";
import { DEFAULT_OPTIONS } from "../types.ts";
import { parseUAsset } from "../parser/parser.ts";
import { initHexView } from "./hex-view.ts";
import { initLegend } from "./legend.ts";
import { formatSize, escHtml } from "./utils.ts";

// ── Elements ──────────────────────────────────────────────────────────────────

const hexPanel     = document.getElementById("hex-panel")!;
const hexColHeader = document.getElementById("hex-col-header")!;
const summaryPanel = document.getElementById("summary-panel")!;
const legendPanel  = document.getElementById("legend-panel")!;
const menuFile     = document.getElementById("menu-file")!;
const dropdownFile = document.getElementById("dropdown-file")!;
const menuFileOpen = document.getElementById("menu-file-open")!;

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
    return;
  }

  renderSummary(result, file);
  const hexView    = initHexView(hexPanel, hexColHeader, buffer, result, DEFAULT_OPTIONS);
  const legendView = initLegend(legendPanel, result.ranges, hexView.updateColorMap);

  // Cross-wire hover sync: each component calls the other's setHovered when the user
  // interacts with it, but setHovered itself never calls onHoverChange to avoid loops.
  hexView.onHoverChange    = legendView.setHovered.bind(legendView);
  legendView.onHoverChange = hexView.setHovered.bind(hexView);

  // Hex click → expand group in legend (if applicable) then scroll legend to that row.
  hexView.onClickRange = (range) => {
    legendView.expandRange(range);
    legendView.scrollToRange(range);
  };

  // Legend click → scroll hex view to that range's start offset.
  legendView.onClickRange = (range) => hexView.scrollToOffset(range.start);
}

// ── Summary panel ─────────────────────────────────────────────────────────────

function renderSummary(result: ParseResult, file: File): void {
  const { summary, totalBytes } = result;
  const path = summary.packageName || "—";

  const modifiedLine = file.lastModified > 0
    ? metaLine("Modified", new Date(file.lastModified).toLocaleString())
    : "";

  summaryPanel.innerHTML = [
    `<div class="asset-class">${escHtml(file.name)}</div>`,
    metaLine("File size",       formatSize(totalBytes)),
    modifiedLine,
    metaLine("Content path",    path),
    metaLine("Engine version",  summary.engineVersion || "—"),
    metaLine("Exports",         `${summary.exports.length}`),
    metaLine("Imports",         `${summary.imports.length}`),
    metaLine("Metadata",        `${summary.metadataCount} ${summary.metadataCount === 1 ? "tag" : "tags"}`),
    ...summary.properties.map(p => metaLine(p.label, p.value)),
  ].join("");
}

function metaLine(label: string, value: string): string {
  return `<div class="meta-line"><span class="meta-label">${escHtml(label)}: </span>${escHtml(value)}</div>`;
}

// ── Dev: auto-load test asset ─────────────────────────────────────────────────

if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
  fetch("/test/assets/5_7_3/SM_cube.uasset")
    .then(r => r.ok ? r.arrayBuffer() : Promise.reject())
    .then(buf => openFile(new File([buf], "SM_cube.uasset")))
    .catch(() => { /* file missing — silently skip */ });
}
