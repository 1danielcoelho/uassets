import type { ParseResult } from "../types.ts";
import { DEFAULT_OPTIONS } from "../types.ts";
import { parseUAsset } from "../parser/parser.ts";
import { initHexView } from "./hex-view.ts";
import { initLegend } from "./legend.ts";
import { formatSize, escHtml, findMatches, type HexViewHandle, type SearchMode } from "./utils.ts";

// ── Elements ──────────────────────────────────────────────────────────────────

const hexPanel     = document.getElementById("hex-panel")!;
const hexColHeader = document.getElementById("hex-col-header")!;
const summaryPanel = document.getElementById("summary-panel")!;
const legendPanel  = document.getElementById("legend-panel")!;
const menuFile     = document.getElementById("menu-file")!;
const dropdownFile = document.getElementById("dropdown-file")!;
const menuFileOpen = document.getElementById("menu-file-open")!;

// ── Search elements ───────────────────────────────────────────────────────────

const searchBar     = document.getElementById("search-bar") as HTMLElement;
const searchInput   = document.getElementById("search-input") as HTMLInputElement;
const searchCount   = document.getElementById("search-count")!;
const searchPrev    = document.getElementById("search-prev") as HTMLButtonElement;
const searchNext    = document.getElementById("search-next") as HTMLButtonElement;
const searchModeHex = document.getElementById("search-mode-hex") as HTMLInputElement;
const searchClose   = document.getElementById("search-close")!;

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

// ── Search state ──────────────────────────────────────────────────────────────

let fileBytes: Uint8Array | null = null;
let hexHandle: HexViewHandle | null = null;
let searchOffsets: number[] = [];
let searchLen     = 0;
let searchActive  = -1;

function runSearch(): void {
  if (!fileBytes || !hexHandle) return;
  const query = searchInput.value;
  const mode: SearchMode = searchModeHex.checked ? "hex" : "text";

  const result = query ? findMatches(fileBytes, query, mode) : { offsets: [], queryLen: 0 };
  searchOffsets = result.offsets;
  searchLen     = result.queryLen;
  searchActive  = searchOffsets.length > 0 ? 0 : -1;

  hexHandle.setSearchState(searchOffsets, searchLen, searchActive);
  updateSearchUI(query);

  if (searchActive >= 0) {
    hexHandle.scrollToOffset(searchOffsets[searchActive]!);
  }
}

function goToMatch(delta: number): void {
  if (searchOffsets.length === 0 || !hexHandle) return;
  searchActive = ((searchActive + delta) % searchOffsets.length + searchOffsets.length) % searchOffsets.length;
  hexHandle.setSearchState(searchOffsets, searchLen, searchActive);
  hexHandle.scrollToOffset(searchOffsets[searchActive]!);
  updateSearchUI(searchInput.value);
}

function updateSearchUI(query: string): void {
  if (searchOffsets.length === 0) {
    searchCount.textContent = query ? "0 matches" : "";
    searchInput.classList.toggle("no-match", !!query);
  } else {
    searchCount.textContent = `${searchActive + 1} / ${searchOffsets.length}`;
    searchInput.classList.remove("no-match");
  }
  searchPrev.disabled = searchOffsets.length === 0;
  searchNext.disabled = searchOffsets.length === 0;
}

function showSearch(): void {
  searchBar.hidden = false;
  searchInput.focus();
  searchInput.select();
}

function hideSearch(): void {
  searchBar.hidden = true;
  searchInput.classList.remove("no-match");
  if (hexHandle) hexHandle.setSearchState([], 0, -1);
  searchOffsets = [];
  searchLen     = 0;
  searchActive  = -1;
  searchCount.textContent = "";
}

searchInput.addEventListener("input", runSearch);

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); goToMatch(e.shiftKey ? -1 : 1); }
  if (e.key === "Escape") { hideSearch(); }
});

searchPrev.addEventListener("click", () => goToMatch(-1));
searchNext.addEventListener("click", () => goToMatch(1));
searchModeHex.addEventListener("change", runSearch);
searchClose.addEventListener("click", hideSearch);

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    e.preventDefault();
    showSearch();
  }
  if (e.key === "Escape" && !searchBar.hidden) {
    hideSearch();
  }
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

  // Reset search state for the new file.
  fileBytes = new Uint8Array(buffer);
  hideSearch();
  searchInput.value = "";

  renderSummary(result, file);
  hexHandle   = initHexView(hexPanel, hexColHeader, buffer, result, DEFAULT_OPTIONS);
  const legendView = initLegend(legendPanel, result.ranges, hexHandle.updateColorMap);

  // Cross-wire hover sync: each component calls the other's setHovered when the user
  // interacts with it, but setHovered itself never calls onHoverChange to avoid loops.
  hexHandle.onHoverChange    = legendView.setHovered.bind(legendView);
  legendView.onHoverChange   = hexHandle.setHovered.bind(hexHandle);

  // Hex click → expand group in legend (if applicable) then scroll legend to that row.
  hexHandle.onClickRange = (range) => {
    legendView.expandRange(range);
    legendView.scrollToRange(range);
  };

  // Legend click → scroll hex view to that range's start offset.
  legendView.onClickRange = (range) => hexHandle!.scrollToOffset(range.start);
}

// ── Summary panel ─────────────────────────────────────────────────────────────

// Track the current thumbnail object URL so we can revoke it when a new file is loaded.
let currentThumbUrl: string | null = null;

function renderSummary(result: ParseResult, file: File): void {
  const { summary, totalBytes } = result;
  const path = summary.packageName || "—";

  const modifiedLine = file.lastModified > 0
    ? metaLine("Modified", new Date(file.lastModified).toLocaleString())
    : "";

  const textHtml = [
    `<div class="asset-class">${escHtml(file.name)}</div>`,
    metaLine("File size",       formatSize(totalBytes)),
    modifiedLine,
    metaLine("Content path",    path),
    metaLine("Engine version",  summary.engineVersion || "—"),
    ...summary.properties.map(p => metaLine(p.label, p.value)),
  ].join("");

  // Revoke any previous blob URL to free memory.
  if (currentThumbUrl) { URL.revokeObjectURL(currentThumbUrl); currentThumbUrl = null; }

  if (summary.thumbnail) {
    const blob = new Blob([summary.thumbnail.data], { type: summary.thumbnail.mimeType });
    currentThumbUrl = URL.createObjectURL(blob);
    const { width, height } = summary.thumbnail;
    const thumbHtml = `<img class="summary-thumb" src="${currentThumbUrl}" ` +
                           `alt="Thumbnail ${width}×${height}" title="${width}×${height}">`;
    // Insert thumbnail after the first element (the filename/asset-class div)
    const splitIdx = textHtml.indexOf("</div>") + "</div>".length;
    summaryPanel.innerHTML = textHtml.slice(0, splitIdx) + thumbHtml + textHtml.slice(splitIdx);
  } else {
    summaryPanel.innerHTML = textHtml;
  }
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
