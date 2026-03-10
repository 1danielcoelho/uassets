import type { ParseResult, ByteRange } from "../types.ts";
import { DEFAULT_OPTIONS } from "../types.ts";
import { parseUAsset } from "../parser/parser.ts";
import { initHexView } from "./hex-view.ts";
import { initLegend, type LegendHandle } from "./legend.ts";
import { formatSize, escHtml, findMatches, findLegendMatches, findAddressMatches, type HexViewHandle } from "./utils.ts";

// ── Elements ──────────────────────────────────────────────────────────────────

const hexPanel     = document.getElementById("hex-panel")!;
const hexColHeader = document.getElementById("hex-col-header")!;
const summaryPanel = document.getElementById("summary-panel")!;
const legendPanel  = document.getElementById("legend-panel")!;
const menuFile     = document.getElementById("menu-file")!;
const dropdownFile = document.getElementById("dropdown-file")!;
const menuFileOpen = document.getElementById("menu-file-open")!;

// ── Search elements ───────────────────────────────────────────────────────────

const searchBar    = document.getElementById("search-bar") as HTMLElement;
const searchInput  = document.getElementById("search-input") as HTMLInputElement;
const searchCount  = document.getElementById("search-count")!;
const searchPrev   = document.getElementById("search-prev") as HTMLButtonElement;
const searchNext   = document.getElementById("search-next") as HTMLButtonElement;
const chkHex       = document.getElementById("search-chk-hex") as HTMLInputElement;
const chkAscii     = document.getElementById("search-chk-ascii") as HTMLInputElement;
const chkAddr      = document.getElementById("search-chk-addr") as HTMLInputElement;
const chkLegend    = document.getElementById("search-chk-legend") as HTMLInputElement;
const searchClose  = document.getElementById("search-close")!;

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

type SearchMatchItem =
  | { kind: "byte";    offset: number; len: number }
  | { kind: "address"; offset: number }
  | { kind: "legend";  range: ByteRange };

let fileBytes:         Uint8Array | null  = null;
let hexHandle:         HexViewHandle | null = null;
let legendHandle:      LegendHandle | null  = null;
let allRanges:         ByteRange[]          = [];

let allMatches:        SearchMatchItem[] = [];
let searchActive       = -1;
let byteMatchGroups:   Array<{ offsets: number[]; len: number }> = [];
let addressOffsets:    number[]    = [];
let legendMatchRanges: ByteRange[] = [];

function runSearch(): void {
  const query = searchInput.value;

  // Byte search: Hex mode (query as hex bytes) and/or ASCII mode (query as UTF-8 text)
  byteMatchGroups = [];
  if (fileBytes && query) {
    if (chkHex.checked) {
      const res = findMatches(fileBytes, query, "hex");
      if (res.queryLen > 0) byteMatchGroups.push({ offsets: res.offsets, len: res.queryLen });
    }
    if (chkAscii.checked) {
      const res = findMatches(fileBytes, query, "text");
      if (res.queryLen > 0) byteMatchGroups.push({ offsets: res.offsets, len: res.queryLen });
    }
  }

  // Address search
  addressOffsets = [];
  if (chkAddr.checked && fileBytes && query) {
    addressOffsets = findAddressMatches(fileBytes.length, DEFAULT_OPTIONS.bytesPerRow, query);
  }

  // Legend search
  legendMatchRanges = [];
  if (chkLegend.checked && query) {
    legendMatchRanges = findLegendMatches(allRanges, query);
  }

  // Byte navigation entries sorted by offset (both modes interleaved)
  const byteNavMatches: SearchMatchItem[] = byteMatchGroups
    .flatMap(g => g.offsets.map(o => ({ kind: "byte" as const, offset: o, len: g.len })))
    .sort((a, b) => a.offset - b.offset);

  // Combined list: byte matches first, then address matches, then legend matches
  allMatches = [
    ...byteNavMatches,
    ...addressOffsets.map(o => ({ kind: "address" as const, offset: o })),
    ...legendMatchRanges.map(r => ({ kind: "legend" as const, range: r })),
  ];

  searchActive = allMatches.length > 0 ? 0 : -1;
  applySearchState();
  updateSearchUI(query);
  if (searchActive >= 0) jumpToMatch(searchActive);
}

function goToMatch(delta: number): void {
  if (allMatches.length === 0) return;
  searchActive = ((searchActive + delta) % allMatches.length + allMatches.length) % allMatches.length;
  applySearchState();
  jumpToMatch(searchActive);
  updateSearchUI(searchInput.value);
}

function applySearchState(): void {
  const m = searchActive >= 0 ? allMatches[searchActive] : null;
  const activeByteOffset  = m?.kind === "byte"    ? m.offset : -1;
  const activeByteLen     = m?.kind === "byte"    ? m.len    : 0;
  const activeAddrOffset  = m?.kind === "address" ? m.offset : -1;
  const activeLegendRange = m?.kind === "legend"  ? m.range  : null;

  hexHandle?.setSearchHighlights(byteMatchGroups, activeByteOffset, activeByteLen, addressOffsets, activeAddrOffset);
  legendHandle?.setSearchResults(legendMatchRanges, activeLegendRange);
}

function findDeepestRangeAtOffset(ranges: ByteRange[], offset: number): ByteRange | null {
  for (const range of ranges) {
    if (offset >= range.start && offset < range.end) {
      if (range.kind === "group" && range.children.length > 0) {
        const child = findDeepestRangeAtOffset(range.children, offset);
        if (child) return child;
      }
      return range;
    }
  }
  return null;
}

function jumpToMatch(idx: number): void {
  const m = allMatches[idx];
  if (!m) return;
  if (m.kind === "byte" || m.kind === "address") {
    hexHandle?.scrollToOffset(m.offset);
    if (legendHandle) {
      const range = findDeepestRangeAtOffset(allRanges, m.offset);
      if (range) legendHandle.expandAndScrollToRange(range);
    }
  } else {
    legendHandle?.expandAndScrollToRange(m.range);
    hexHandle?.scrollToOffset(m.range.start);
  }
}

function updateSearchUI(query: string): void {
  if (allMatches.length === 0) {
    searchCount.textContent = query ? "0 matches" : "";
    searchInput.classList.toggle("no-match", !!query);
  } else {
    searchCount.textContent = `${searchActive + 1} / ${allMatches.length}`;
    searchInput.classList.remove("no-match");
  }
  searchPrev.disabled = allMatches.length === 0;
  searchNext.disabled = allMatches.length === 0;
}

function clearSearchState(): void {
  allMatches        = [];
  byteMatchGroups   = [];
  addressOffsets    = [];
  legendMatchRanges = [];
  searchActive      = -1;
  searchInput.classList.remove("no-match");
  searchCount.textContent = "";
}

function showSearch(): void {
  searchBar.hidden = false;
  searchInput.focus();
  searchInput.select();
  applySearchState();
  updateSearchUI(searchInput.value);
}

function hideSearch(): void {
  searchBar.hidden = true;
  hexHandle?.setSearchHighlights([], -1, 0, [], -1);
  legendHandle?.setSearchResults([], null);
}

let searchDebounceTimer = 0;
searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(runSearch, 150) as unknown as number;
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); goToMatch(e.shiftKey ? -1 : 1); }
  if (e.key === "Escape") { hideSearch(); }
});

searchPrev.addEventListener("click", () => goToMatch(-1));
searchNext.addEventListener("click", () => goToMatch(1));
chkHex.addEventListener("change", runSearch);
chkAscii.addEventListener("change", runSearch);
chkAddr.addEventListener("change", runSearch);
chkLegend.addEventListener("change", runSearch);
searchClose.addEventListener("click", hideSearch);

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    e.preventDefault();
    showSearch();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "g") {
    e.preventDefault();
    chkHex.checked    = false;
    chkAscii.checked  = false;
    chkAddr.checked   = true;
    chkLegend.checked = false;
    showSearch();
    runSearch();
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
  fileBytes  = new Uint8Array(buffer);
  allRanges  = result.ranges;
  hideSearch();
  clearSearchState();
  searchInput.value = "";

  renderSummary(result, file);
  hexHandle    = initHexView(hexPanel, hexColHeader, buffer, result, DEFAULT_OPTIONS);
  legendHandle = initLegend(legendPanel, result.ranges, hexHandle.updateColorMap);

  // Cross-wire hover sync.
  hexHandle.onHoverChange    = legendHandle.setHovered.bind(legendHandle);
  legendHandle.onHoverChange = hexHandle.setHovered.bind(hexHandle);

  // Hex click → expand group in legend (if applicable) then scroll legend to that row.
  hexHandle.onClickRange = (range) => {
    legendHandle!.expandRange(range);
    legendHandle!.scrollToRange(range);
  };

  // Legend click → scroll hex view to that range's start offset.
  legendHandle.onClickRange = (range) => hexHandle!.scrollToOffset(range.start);
}

// ── Summary panel ─────────────────────────────────────────────────────────────

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

  if (currentThumbUrl) { URL.revokeObjectURL(currentThumbUrl); currentThumbUrl = null; }

  if (summary.thumbnail) {
    const blob = new Blob([summary.thumbnail.data.buffer.slice(0) as ArrayBuffer], { type: summary.thumbnail.mimeType });
    currentThumbUrl = URL.createObjectURL(blob);
    const { width, height } = summary.thumbnail;
    const thumbHtml = `<img class="summary-thumb" src="${currentThumbUrl}" ` +
                           `alt="Thumbnail ${width}×${height}" title="${width}×${height}">`;
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
