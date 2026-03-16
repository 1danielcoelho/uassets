import type { ByteRange } from "../types.ts";
import {
  colorForLabel, buildActiveRanges, removeDescendantsFromExpanded,
  formatSize, valueStr,
  type ColoredRange, type ViewerHandle, type HoverRange,
} from "./utils.ts";

// ── Public types ──────────────────────────────────────────────────────────────

export interface AnnotationHandle extends ViewerHandle {
  expandRange(range: ByteRange): void;
  toggleRange(range: ByteRange): void;
  expandAll(): void;
  collapseAll(): void;
  scrollToRange(range: ByteRange): void;
  expandAndScrollToRange(range: ByteRange): void;
  setSearchResults(matches: ByteRange[], activeRange: ByteRange | null): void;
  onClickRange: ((range: ByteRange) => void) | null;
}

// ── Internal ──────────────────────────────────────────────────────────────────

interface RowInfo {
  directChildRows:   HTMLTableRowElement[];
  allDescendantRows: HTMLTableRowElement[];
  toggleEl:          HTMLElement;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function initAnnotation(
  container: HTMLElement,
  ranges: ByteRange[],
  onColorMapChange?: (ranges: ColoredRange[]) => void,
): AnnotationHandle {
  container.innerHTML = "";
  const table = document.createElement("table");
  table.className = "annotation-table";
  container.appendChild(table);

  // ── Expansion state ──
  const expandedRanges = new Set<ByteRange>();

  const notifyChange = onColorMapChange
    ? () => onColorMapChange(buildActiveRanges(ranges, expandedRanges))
    : () => {};

  // ── Row map (start offset → <tr>[]) for hover sync ──
  const rowMap = new Map<number, HTMLTableRowElement[]>();

  // ── Range → row info map for programmatic expansion ──
  const rangeToRowInfo = new Map<ByteRange, RowInfo>();

  // ── Range ↔ row maps for click-to-scroll ──
  const rangeToTr = new Map<ByteRange, HTMLTableRowElement>();
  const trToRange = new Map<HTMLTableRowElement, ByteRange>();

  // ── Parent map for ancestor-expansion ──
  const rangeToParent = new Map<ByteRange, ByteRange>();

  // ── Search highlight state ──
  let searchHighlightedTrs: HTMLTableRowElement[] = [];

  // ── Rows ──
  const tbody = table.createTBody();
  for (const range of ranges) {
    buildRows(tbody, range, 0, expandedRanges, notifyChange, rowMap, rangeToRowInfo, rangeToTr, trToRange, rangeToParent, undefined);
  }

  // ── Hover state ──
  let hoveredRow: HTMLTableRowElement | null = null;
  let lastHoveredStart: number | null = null;
  let lastHoveredEnd:   number | null = null;

  const handle: AnnotationHandle = {
    onHoverChange: null,
    onClickRange: null,

    setHovered(range: HoverRange | null): void {
      if (hoveredRow) {
        hoveredRow.classList.remove("hovered");
        hoveredRow = null;
      }
      if (range !== null) {
        const rows = rowMap.get(range.start);
        // Pick the first visible row (groups and their first child share a start offset;
        // only the currently-relevant one will be visible).
        const row = rows?.find(r => r.style.display !== "none") ?? null;
        if (row) {
          row.classList.add("hovered");
          hoveredRow = row;
        }
      }
    },

    expandRange(range: ByteRange): void {
      if (range.kind !== "group") return;
      const info = rangeToRowInfo.get(range);
      if (!info) return;
      const { directChildRows, toggleEl } = info;
      // If already expanded, do nothing (search/navigate is expand-only)
      const isExpanded = directChildRows.length > 0 && directChildRows[0]!.style.display !== "none";
      if (isExpanded) return;
      toggleEl.textContent = "▼";
      for (const row of directChildRows) row.style.display = "";
      expandedRanges.add(range);
      notifyChange();
    },

    toggleRange(range: ByteRange): void {
      if (range.kind !== "group") return;
      const info = rangeToRowInfo.get(range);
      if (!info) return;
      const { directChildRows, allDescendantRows, toggleEl } = info;
      const isExpanded = directChildRows.length > 0 && directChildRows[0]!.style.display !== "none";
      if (isExpanded) {
        toggleEl.textContent = "▶";
        for (const row of allDescendantRows) {
          row.style.display = "none";
          const innerToggle = row.querySelector<HTMLElement>(".annotation-toggle");
          if (innerToggle) innerToggle.textContent = "▶";
        }
        removeDescendantsFromExpanded(range, expandedRanges);
        notifyChange();
      } else {
        toggleEl.textContent = "▼";
        for (const row of directChildRows) row.style.display = "";
        expandedRanges.add(range);
        notifyChange();
      }
    },

    expandAll(): void {
      for (const [, info] of rangeToRowInfo) {
        info.toggleEl.textContent = "▼";
        for (const row of info.allDescendantRows) row.style.display = "";
      }
      for (const [range] of rangeToRowInfo) expandedRanges.add(range);
      notifyChange();
    },

    collapseAll(): void {
      expandedRanges.clear();
      for (const [, info] of rangeToRowInfo) {
        info.toggleEl.textContent = "▶";
        for (const row of info.allDescendantRows) row.style.display = "none";
      }
      notifyChange();
    },

    scrollToRange(range: ByteRange): void {
      const tr = rangeToTr.get(range);
      if (!tr) return;
      const containerRect = container.getBoundingClientRect();
      const trRect        = tr.getBoundingClientRect();
      const visibleTop    = containerRect.top;
      const visibleBottom = containerRect.bottom;
      if (trRect.top >= visibleTop && trRect.bottom <= visibleBottom) return;
      const visibleHeight  = visibleBottom - visibleTop;
      const rowHeight      = trRect.bottom - trRect.top;
      const absoluteRowTop = container.scrollTop + trRect.top - visibleTop;
      const centeredTop    = absoluteRowTop - (visibleHeight - rowHeight) / 2;
      container.scrollTo({ top: Math.max(0, centeredTop), behavior: "smooth" });
    },

    expandAndScrollToRange(range: ByteRange): void {
      // Collect ancestors from closest to root
      const ancestors: ByteRange[] = [];
      let cur = rangeToParent.get(range);
      while (cur !== undefined) {
        ancestors.push(cur);
        cur = rangeToParent.get(cur);
      }
      // Expand from root downward
      for (let i = ancestors.length - 1; i >= 0; i--) {
        handle.expandRange(ancestors[i]!);
      }
      handle.scrollToRange(range);
    },

    setSearchResults(matches: ByteRange[], activeRange: ByteRange | null): void {
      for (const tr of searchHighlightedTrs) {
        tr.classList.remove("annotation-search-match", "annotation-search-active");
      }
      searchHighlightedTrs = [];

      for (const range of matches) {
        const tr = rangeToTr.get(range);
        if (tr) {
          tr.classList.add("annotation-search-match");
          searchHighlightedTrs.push(tr);
        }
      }

      if (activeRange !== null) {
        const tr = rangeToTr.get(activeRange);
        if (tr) {
          tr.classList.add("annotation-search-active");
          searchHighlightedTrs.push(tr);
        }
      }
    },
  };

  // ── Table click handler — fire onClickRange for navigation ──
  table.addEventListener("click", (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLTableRowElement>("tr[data-byteoffset]");
    if (!tr) return;
    const range = trToRange.get(tr);
    if (range) handle.onClickRange?.(range);
  });

  // ── Table hover handlers ──
  table.addEventListener("mouseover", (e) => {
    const tr    = (e.target as HTMLElement).closest<HTMLTableRowElement>("tr[data-byteoffset]");
    const start = tr ? Number(tr.getAttribute("data-byteoffset")) : null;
    const end   = tr ? Number(tr.getAttribute("data-rangeend"))   : null;
    // Deduplicate on both start AND end: the group row and its first child share
    // the same start offset but have different end offsets, so we must distinguish them.
    if (start === lastHoveredStart && end === lastHoveredEnd) return;
    lastHoveredStart = start;
    lastHoveredEnd   = end;
    if (start !== null && end !== null) {
      handle.onHoverChange?.({ start, end });
    } else {
      handle.onHoverChange?.(null);
    }
  });

  table.addEventListener("mouseleave", () => {
    if (lastHoveredStart === null) return;
    lastHoveredStart = null;
    lastHoveredEnd   = null;
    handle.onHoverChange?.(null);
  });

  return handle;
}

// ── Row builder ───────────────────────────────────────────────────────────────

function buildRows(
  tbody: HTMLTableSectionElement,
  range: ByteRange,
  depth: number,
  expandedRanges: Set<ByteRange>,
  notifyChange: () => void,
  rowMap: Map<number, HTMLTableRowElement[]>,
  rangeToRowInfo: Map<ByteRange, RowInfo>,
  rangeToTr: Map<ByteRange, HTMLTableRowElement>,
  trToRange: Map<HTMLTableRowElement, ByteRange>,
  rangeToParent: Map<ByteRange, ByteRange>,
  parent: ByteRange | undefined,
): HTMLTableRowElement[] {
  if (parent !== undefined) rangeToParent.set(range, parent);

  const hasChildren = range.kind === "group" && range.children.length > 0;

  const tr = document.createElement("tr");
  tr.className = hasChildren ? "annotation-row annotation-group-row" : "annotation-row";
  tr.setAttribute("data-byteoffset", String(range.start));
  tr.setAttribute("data-rangeend",   String(range.end));
  const existing = rowMap.get(range.start);
  if (existing) existing.push(tr);
  else rowMap.set(range.start, [tr]);
  rangeToTr.set(range, tr);
  trToRange.set(tr, range);

  // ── Swatch — all rows get their own color ──
  const swatchTd = document.createElement("td");
  swatchTd.className = "annotation-swatch";
  const dot = document.createElement("div");
  dot.className = "swatch-dot";
  dot.style.background = colorForLabel(range.label);
  swatchTd.appendChild(dot);
  tr.appendChild(swatchTd);

  // ── Size ──
  const sizeTd = document.createElement("td");
  sizeTd.className = "annotation-size";
  sizeTd.textContent = formatSize(range.end - range.start);
  tr.appendChild(sizeTd);

  // ── Name ──
  const nameTd = document.createElement("td");
  nameTd.className = "annotation-name";
  nameTd.style.paddingLeft = `${depth * 12 + 4}px`;
  if (hasChildren) {
    nameTd.appendChild(document.createTextNode(range.label + " "));
    const toggle = document.createElement("span");
    toggle.className = "annotation-toggle";
    toggle.textContent = "▶";
    nameTd.appendChild(toggle);
  } else {
    nameTd.textContent = range.label;
  }
  tr.appendChild(nameTd);

  // ── Value ──
  const valueTd = document.createElement("td");
  valueTd.className = "annotation-value";
  valueTd.textContent = valueStr(range);
  tr.appendChild(valueTd);

  tbody.appendChild(tr);
  const result: HTMLTableRowElement[] = [tr];

  // ── Children ──
  if (hasChildren && range.kind === "group") {
    const children = range.children;
    const allDescendantRows: HTMLTableRowElement[] = [];
    const directChildRows:   HTMLTableRowElement[] = [];

    for (const child of children) {
      const rows = buildRows(tbody, child, depth + 1, expandedRanges, notifyChange, rowMap, rangeToRowInfo, rangeToTr, trToRange, rangeToParent, range);
      allDescendantRows.push(...rows);
      directChildRows.push(rows[0]!);
      result.push(...rows);
    }

    for (const row of allDescendantRows) row.style.display = "none";

    const toggleEl = nameTd.querySelector<HTMLElement>(".annotation-toggle")!;

    rangeToRowInfo.set(range, { directChildRows, allDescendantRows, toggleEl });

    // Double-click: toggle expand/collapse
    tr.addEventListener("dblclick", () => {
      const isExpanded = directChildRows.length > 0 && directChildRows[0]!.style.display !== "none";
      if (isExpanded) {
        toggleEl.textContent = "▶";
        for (const row of allDescendantRows) {
          row.style.display = "none";
          const innerToggle = row.querySelector<HTMLElement>(".annotation-toggle");
          if (innerToggle) innerToggle.textContent = "▶";
        }
        removeDescendantsFromExpanded(range, expandedRanges);
        notifyChange();
      } else {
        toggleEl.textContent = "▼";
        for (const row of directChildRows) row.style.display = "";
        expandedRanges.add(range);
        notifyChange();
      }
    });
  }

  return result;
}
