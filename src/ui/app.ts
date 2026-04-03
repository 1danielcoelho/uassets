import type { ParseResult, ByteRange } from "../types.ts";
import { DEFAULT_OPTIONS } from "../types.ts";
import { parseUAsset } from "../parser/parser.ts";
import { initHexView, hexColumnWidth, ROW_HEIGHT } from "./hex-view.ts";
import { initAnnotation, type AnnotationHandle } from "./annotation.ts";
import { formatSize, escHtml, findMatches, findAnnotationMatches, findAddressMatches, buildActiveRanges, type HexViewHandle, type ColoredRange } from "./utils.ts";
import { initMinimap, type MinimapHandle } from "./minimap.ts";

// ── Elements ──────────────────────────────────────────────────────────────────

const hexPanel          = document.getElementById("hex-panel")!;
const hexColHeader      = document.getElementById("hex-col-header")!;
const hexColumn         = document.getElementById("hex-column")!;
const minimapColumn     = document.getElementById("minimap-column")!;
const minimapContainer  = document.getElementById("minimap-container")!;
const summaryPanel      = document.getElementById("summary-panel")!;
const annotationPanel   = document.getElementById("annotation-panel")!;
const menuFile          = document.getElementById("menu-file")!;
const dropdownFile      = document.getElementById("dropdown-file")!;
const menuFileOpen      = document.getElementById("menu-file-open")!;
const submenuExamples   = document.getElementById("submenu-examples")!;
const btnExpandAll      = document.getElementById("btn-expand-all")!;
const btnCollapseAll    = document.getElementById("btn-collapse-all")!;

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
  | { kind: "byte";       offset: number; len: number }
  | { kind: "address";    offset: number }
  | { kind: "annotation"; range: ByteRange };

let fileBytes:              Uint8Array | null        = null;
let hexHandle:              HexViewHandle | null     = null;
let annotationHandle:       AnnotationHandle | null  = null;
let minimapHandle:          MinimapHandle | null     = null;
let allRanges:              ByteRange[]              = [];
let currentFileAbort:       AbortController | null  = null;

let allMatches:             SearchMatchItem[] = [];
let searchActive            = -1;
let byteMatchGroups:        Array<{ offsets: number[]; len: number }> = [];
let addressOffsets:         number[]    = [];
let annotationMatchRanges:  ByteRange[] = [];

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

  // Annotation search
  annotationMatchRanges = [];
  if (chkLegend.checked && query) {
    annotationMatchRanges = findAnnotationMatches(allRanges, query);
  }

  // Byte navigation entries sorted by offset (both modes interleaved)
  const byteNavMatches: SearchMatchItem[] = byteMatchGroups
    .flatMap(g => g.offsets.map(o => ({ kind: "byte" as const, offset: o, len: g.len })))
    .sort((a, b) => a.offset - b.offset);

  // Combined list: byte matches first, then address matches, then annotation matches
  allMatches = [
    ...byteNavMatches,
    ...addressOffsets.map(o => ({ kind: "address" as const, offset: o })),
    ...annotationMatchRanges.map(r => ({ kind: "annotation" as const, range: r })),
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
  const activeByteOffset    = m?.kind === "byte"       ? m.offset : -1;
  const activeByteLen       = m?.kind === "byte"       ? m.len    : 0;
  const activeAddrOffset    = m?.kind === "address"    ? m.offset : -1;
  const activeAnnotRange    = m?.kind === "annotation" ? m.range  : null;

  hexHandle?.setSearchHighlights(byteMatchGroups, activeByteOffset, activeByteLen, addressOffsets, activeAddrOffset);
  annotationHandle?.setSearchResults(annotationMatchRanges, activeAnnotRange);
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
    if (annotationHandle) {
      const range = findDeepestRangeAtOffset(allRanges, m.offset);
      if (range) annotationHandle.expandAndScrollToRange(range);
    }
  } else {
    annotationHandle?.expandAndScrollToRange(m.range);
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
  allMatches            = [];
  byteMatchGroups       = [];
  addressOffsets        = [];
  annotationMatchRanges = [];
  searchActive          = -1;
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
  annotationHandle?.setSearchResults([], null);
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

// ── Expand / Collapse all ─────────────────────────────────────────────────────

btnExpandAll.addEventListener("click",  () => annotationHandle?.expandAll());
btnCollapseAll.addEventListener("click", () => annotationHandle?.collapseAll());

// ── Open & parse ──────────────────────────────────────────────────────────────

async function openFile(file: File): Promise<void> {
  currentFileAbort?.abort();
  currentFileAbort = new AbortController();
  const { signal } = currentFileAbort;

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

  document.body.classList.remove("no-file");
  renderSummary(result, file);
  hexColHeader.classList.remove("hidden");
  hexColumn.style.width = `${hexColumnWidth(DEFAULT_OPTIONS.bytesPerRow)}px`;

  const totalScrollHeight = Math.ceil(result.totalBytes / DEFAULT_OPTIONS.bytesPerRow) * ROW_HEIGHT;

  // Color map change callback notifies both hex view and minimap.
  function onColorMapChange(ranges: ColoredRange[]): void {
    hexHandle!.updateColorMap(ranges);
    minimapHandle?.updateColorMap(ranges);
  }

  hexHandle        = initHexView(hexPanel, hexColHeader, buffer, result, DEFAULT_OPTIONS);
  minimapHandle    = initMinimap(
    minimapContainer,
    buildActiveRanges(result.ranges, new Set()),
    result.totalBytes,
    (scrollTop) => { hexPanel.scrollTo({ top: scrollTop, behavior: "smooth" }); },
  );
  annotationHandle = initAnnotation(annotationPanel, result.ranges, onColorMapChange);

  // Show minimap now that a file is loaded.
  minimapColumn.classList.add("visible");

  // Keep minimap viewport indicator in sync with hex panel scrolling.
  hexPanel.addEventListener("scroll", () => {
    minimapHandle?.updateViewport(hexPanel.scrollTop, hexPanel.clientHeight, totalScrollHeight);
  }, { signal });
  minimapHandle.updateViewport(hexPanel.scrollTop, hexPanel.clientHeight, totalScrollHeight);

  // Cross-wire hover sync.
  hexHandle.onHoverChange        = annotationHandle.setHovered.bind(annotationHandle);
  annotationHandle.onHoverChange = hexHandle.setHovered.bind(hexHandle);

  // Hex single click → expand the clicked range (if a group) + expand ancestors + scroll to it.
  hexHandle.onClickRange = (range) => {
    annotationHandle!.expandRange(range);
    annotationHandle!.expandAndScrollToRange(range);
  };

  // Annotation right-click → context menu → "View bytes" fires onClickRange.
  annotationHandle.onClickRange = (range) => hexHandle!.scrollToOffset(range.start);

  // Hex right-click → shared context menu with "View annotation" as primary action.
  hexHandle.onContextMenuRange = (range, x, y) => {
    annotationHandle!.showContextMenuAt(range, x, y, "View annotation", () => {
      annotationHandle!.scrollToNearestVisible(range);
    });
  };
}

// ── Summary panel ─────────────────────────────────────────────────────────────

let currentThumbUrl: string | null = null;

function renderSummary(result: ParseResult, file: File): void {
  const { summary, totalBytes } = result;
  const path = summary.packageName || "—";

  const modifiedLine = file.lastModified > 0
    ? metaLine("Modified", new Date(file.lastModified).toLocaleString())
    : "";

  const metaHtml = [
    metaLine("File size",       formatSize(totalBytes)),
    modifiedLine,
    metaLine("Content path",    path),
    metaLine("Engine version",  summary.engineVersion || "—"),
    ...summary.properties.map(p => metaLine(p.label, p.value)),
  ].join("");
  const textHtml =
    `<div class="asset-class">${escHtml(file.name)}</div>` +
    `<div class="summary-meta">${metaHtml}</div>`;

  if (currentThumbUrl) { URL.revokeObjectURL(currentThumbUrl); currentThumbUrl = null; }

  let thumbInnerHtml: string;
  if (summary.thumbnail) {
    const blob = new Blob([summary.thumbnail.data.buffer.slice(0) as ArrayBuffer], { type: summary.thumbnail.mimeType });
    currentThumbUrl = URL.createObjectURL(blob);
    const { width, height } = summary.thumbnail;
    thumbInnerHtml = `<img class="summary-thumb" src="${currentThumbUrl}" ` +
                          `alt="Thumbnail ${width}×${height}" title="${width}×${height}">`;
  } else {
    thumbInnerHtml = `<div class="summary-thumb-placeholder" title="No embedded thumbnail"></div>`;
  }

  summaryPanel.innerHTML =
    `<div class="summary-body">` +
      `<div class="summary-thumb-container">${thumbInnerHtml}</div>` +
      `<div class="summary-text">${textHtml}</div>` +
    `</div>`;
}

function metaLine(label: string, value: string): string {
  return `<div class="meta-line"><span class="meta-label">${escHtml(label)}: </span>${escHtml(value)}</div>`;
}

// ── Welcome screen ────────────────────────────────────────────────────────────

const EXAMPLE_ASSETS: { file: string; label: string }[] = [
  { file: "SM_cube.uasset",           label: "Static Mesh"       },
  { file: "Blueprint.uasset",         label: "Blueprint"         },
  { file: "M_CustomMaterial.uasset",  label: "Material"          },
  { file: "MI_TextureMaterial.uasset",label: "Material Instance" },
  { file: "MyMap.umap",               label: "Level"             },
  { file: "T_shapes.uasset",          label: "Texture"           },
];

function loadExampleAsset(name: string): void {
  dropdownFile.classList.remove("open");
  fetch(`examples/${name}`)
    .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then(buf => openFile(new File([buf], name)))
    .catch(err => alert(`Could not load example asset: ${err.message}`));
}

// ── Populate File → Open example submenu ──────────────────────────────────────

for (const { file, label } of EXAMPLE_ASSETS) {
  const item = document.createElement("div");
  item.className = "dropdown-item";
  item.textContent = label;
  item.addEventListener("click", (e) => {
    e.stopPropagation();
    loadExampleAsset(file);
  });
  submenuExamples.appendChild(item);
}

function showWelcome(): void {
  document.body.classList.add("no-file");
  hexColHeader.classList.add("hidden");
  const btns = EXAMPLE_ASSETS.map(({ file, label }) =>
    `<button class="example-btn" data-asset="${escHtml(file)}">${escHtml(label)}</button>`
  ).join("");
  hexPanel.innerHTML =
    `<div class="welcome">` +
    `<p class="placeholder">Use <strong>File → Open</strong> or drag-and-drop a <code>.uasset</code> / <code>.umap</code> file,` +
    ` or open one of the bundled examples:</p>` +
    `<div class="example-btns">${btns}</div>` +
    `</div>`;
  hexPanel.querySelectorAll<HTMLButtonElement>(".example-btn").forEach(btn => {
    btn.addEventListener("click", () => loadExampleAsset(btn.dataset.asset!));
  });
}

showWelcome();

// ── Dev: auto-load test asset (disabled — use example buttons above) ──────────

if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
  fetch("examples/SM_cube.uasset")
    .then(r => r.ok ? r.arrayBuffer() : Promise.reject())
    .then(buf => openFile(new File([buf], "SM_cube.uasset")))
    .catch(() => { /* file missing — silently skip */ });
}
