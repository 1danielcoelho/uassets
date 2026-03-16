import type { ByteRange } from "../types.ts";
import {
  colorForLabel, buildActiveRanges, removeDescendantsFromExpanded,
  formatSize, valueStr,
  type ColoredRange, type ViewerHandle, type HoverRange,
} from "./utils.ts";

// ── Cleanup controller — aborted when initAnnotation is called again ──────────
let cleanupController: AbortController | null = null;

// ── Public types ──────────────────────────────────────────────────────────────

export interface AnnotationHandle extends ViewerHandle {
  expandRange(range: ByteRange): void;
  toggleRange(range: ByteRange): void;
  expandAll(): void;
  collapseAll(): void;
  scrollToRange(range: ByteRange): void;
  expandAndScrollToRange(range: ByteRange): void;
  /** Scroll to the deepest ancestor of range that is currently visible (no expansion). */
  scrollToNearestVisible(range: ByteRange): void;
  setSearchResults(matches: ByteRange[], activeRange: ByteRange | null): void;
  /** Show the expand/collapse context menu at (x, y). The primary item uses the given label and action. */
  showContextMenuAt(range: ByteRange, x: number, y: number, primaryLabel: string, onPrimary: () => void): void;
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
  // Abort previous instance's global listeners and remove its context menu.
  cleanupController?.abort();
  cleanupController = new AbortController();
  const { signal } = cleanupController;

  document.getElementById("annotation-ctx-menu")?.remove();

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

  // ── Context menu state (shared across annotation + hex-view triggers) ──
  const ctxMenu = document.createElement("div");
  ctxMenu.id = "annotation-ctx-menu";
  ctxMenu.className = "ctx-menu";
  ctxMenu.innerHTML = `
    <div class="ctx-menu-item" data-action="primary"></div>
    <div class="ctx-menu-divider"></div>
    <div class="ctx-menu-item" data-action="expand">Expand</div>
    <div class="ctx-menu-item" data-action="expand-recursive">Expand recursively</div>
    <div class="ctx-menu-item" data-action="collapse">Collapse</div>
    <div class="ctx-menu-item" data-action="collapse-parent">Collapse parent</div>
  `;
  document.body.appendChild(ctxMenu);

  const ctxItems = new Map<string, HTMLElement>();
  for (const el of ctxMenu.querySelectorAll<HTMLElement>(".ctx-menu-item")) {
    ctxItems.set(el.dataset["action"]!, el);
  }

  let ctxMenuRange: ByteRange | null = null;
  let ctxOnPrimary: (() => void) | null = null;

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
      const containerRect  = container.getBoundingClientRect();
      const trRect         = tr.getBoundingClientRect();
      const visibleHeight  = containerRect.bottom - containerRect.top;
      const rowHeight      = trRect.bottom - trRect.top;
      const absoluteRowTop = container.scrollTop + trRect.top - containerRect.top;
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

    scrollToNearestVisible(range: ByteRange): void {
      // Walk from range toward root; stop at the first row that is currently visible.
      let cur: ByteRange | undefined = range;
      while (cur !== undefined) {
        const tr = rangeToTr.get(cur);
        if (tr && tr.style.display !== "none") {
          handle.scrollToRange(cur);
          return;
        }
        cur = rangeToParent.get(cur);
      }
    },

    showContextMenuAt(range: ByteRange, x: number, y: number, primaryLabel: string, onPrimary: () => void): void {
      ctxMenuRange = range;
      ctxOnPrimary = onPrimary;
      ctxItems.get("primary")!.textContent = primaryLabel;

      const isGroup    = range.kind === "group";
      const info       = rangeToRowInfo.get(range);
      const isExpanded = isGroup && info !== undefined && info.directChildRows[0]?.style.display !== "none";
      const hasParent  = rangeToParent.has(range);

      const setDisabled = (action: string, disabled: boolean) =>
        ctxItems.get(action)?.classList.toggle("disabled", disabled);

      setDisabled("expand",           !isGroup || isExpanded);
      setDisabled("expand-recursive", !isGroup);
      setDisabled("collapse",         !isGroup || !isExpanded);
      setDisabled("collapse-parent",  !hasParent);

      ctxMenu.style.left = `${x}px`;
      ctxMenu.style.top  = `${y}px`;
      ctxMenu.classList.add("visible");
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

  // ── Table click handler — group rows toggle expand/collapse; leaf rows do nothing ──
  table.addEventListener("click", (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLTableRowElement>("tr[data-byteoffset]");
    if (!tr || !tr.classList.contains("annotation-group-row")) return;
    const range = trToRange.get(tr);
    if (range) handle.toggleRange(range);
  });

  // ── Context menu click handler ──
  ctxMenu.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".ctx-menu-item");
    if (!item || item.classList.contains("disabled")) {
      ctxMenu.classList.remove("visible");
      ctxMenuRange = null;
      ctxOnPrimary = null;
      return;
    }
    const r = ctxMenuRange;
    if (r) {
      switch (item.dataset["action"]) {
        case "primary":
          ctxOnPrimary?.();
          break;
        case "expand":
          handle.expandRange(r);
          break;
        case "expand-recursive": {
          if (r.kind !== "group") break;
          const info = rangeToRowInfo.get(r);
          if (!info) break;
          const descRowSet = new Set(info.allDescendantRows);
          info.toggleEl.textContent = "▼";
          for (const row of info.allDescendantRows) {
            row.style.display = "";
            const t = row.querySelector<HTMLElement>(".annotation-toggle");
            if (t) t.textContent = "▼";
          }
          expandedRanges.add(r);
          for (const [gr, gInfo] of rangeToRowInfo) {
            if (gInfo.directChildRows[0] && descRowSet.has(gInfo.directChildRows[0])) {
              expandedRanges.add(gr);
            }
          }
          notifyChange();
          break;
        }
        case "collapse":
          handle.toggleRange(r);
          break;
        case "collapse-parent": {
          const parent = rangeToParent.get(r);
          if (parent) handle.toggleRange(parent);
          break;
        }
      }
    }
    ctxMenu.classList.remove("visible");
    ctxMenuRange = null;
    ctxOnPrimary = null;
  });

  window.addEventListener("click", (e) => {
    if (!ctxMenu.classList.contains("visible")) return;
    if (!ctxMenu.contains(e.target as Node)) {
      ctxMenu.classList.remove("visible");
      ctxMenuRange = null;
      ctxOnPrimary = null;
    }
  }, { signal });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && ctxMenu.classList.contains("visible")) {
      ctxMenu.classList.remove("visible");
      ctxMenuRange = null;
      ctxOnPrimary = null;
    }
  }, { signal });

  // ── Annotation table contextmenu — "View bytes" as primary action ──
  table.addEventListener("contextmenu", (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLTableRowElement>("tr[data-byteoffset]");
    if (!tr) return;
    e.preventDefault();
    const r = trToRange.get(tr);
    if (!r) return;
    handle.showContextMenuAt(r, e.clientX, e.clientY, "View bytes", () => handle.onClickRange?.(r));
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
  }

  return result;
}
