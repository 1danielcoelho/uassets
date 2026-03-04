import type { ByteRange } from "../types.ts";
import {
  colorForLabel, buildActiveRanges, removeDescendantsFromExpanded,
  formatSize, valueStr,
  type ColoredRange, type ViewerHandle, type HoverRange,
} from "./utils.ts";

// ── Public types ──────────────────────────────────────────────────────────────

export interface LegendHandle extends ViewerHandle {
  expandRange(range: ByteRange): void;
}

// ── Internal ──────────────────────────────────────────────────────────────────

interface RowInfo {
  directChildRows:   HTMLTableRowElement[];
  allDescendantRows: HTMLTableRowElement[];
  toggleEl:          HTMLElement;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function initLegend(
  container: HTMLElement,
  ranges: ByteRange[],
  onColorMapChange?: (ranges: ColoredRange[]) => void,
): LegendHandle {
  container.innerHTML = "";
  const table = document.createElement("table");
  table.className = "legend-table";
  container.appendChild(table);

  // ── Sticky header ──
  const thead = table.createTHead();
  const hrow = thead.insertRow();
  hrow.className = "legend-header-row";
  for (const [cls, text] of [
    ["legend-swatch", ""],
    ["legend-size",   "Bytes"],
    ["legend-name",   "Name"],
    ["legend-value",  "Value"],
  ] as [string, string][]) {
    const th = document.createElement("th");
    th.className = cls;
    th.textContent = text;
    hrow.appendChild(th);
  }

  // ── Expansion state ──
  const expandedRanges = new Set<ByteRange>();

  const notifyChange = onColorMapChange
    ? () => onColorMapChange(buildActiveRanges(ranges, expandedRanges))
    : () => {};

  // ── Row map (start offset → <tr>[]) for hover sync ──
  // Multiple rows can share the same start offset (e.g. a group and its first child);
  // setHovered picks the first visible one.
  const rowMap = new Map<number, HTMLTableRowElement[]>();

  // ── Range → row info map for programmatic expansion ──
  const rangeToRowInfo = new Map<ByteRange, RowInfo>();

  // ── Rows ──
  const tbody = table.createTBody();
  for (const range of ranges) {
    buildRows(tbody, range, 0, expandedRanges, notifyChange, rowMap, rangeToRowInfo);
  }

  // ── Hover state ──
  let hoveredRow: HTMLTableRowElement | null = null;
  let lastHoveredStart: number | null = null;
  let lastHoveredEnd:   number | null = null;

  const handle: LegendHandle = {
    // This receives the hex view's setHovered
    onHoverChange: null,

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
      // If already expanded, do nothing (hex click is expand-only)
      const isExpanded = directChildRows.length > 0 && directChildRows[0]!.style.display !== "none";
      if (isExpanded) return;
      toggleEl.textContent = "▼";
      for (const row of directChildRows) row.style.display = "";
      expandedRanges.add(range);
      notifyChange();
    },
  };

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
): HTMLTableRowElement[] {
  const isGroup     = range.kind === "group";
  const hasChildren = isGroup && (range as Extract<ByteRange, { kind: "group" }>).children.length > 0;

  const tr = document.createElement("tr");
  tr.className = hasChildren ? "legend-row legend-group-row" : "legend-row";
  tr.setAttribute("data-byteoffset", String(range.start));
  tr.setAttribute("data-rangeend",   String(range.end));
  const existing = rowMap.get(range.start);
  if (existing) existing.push(tr);
  else rowMap.set(range.start, [tr]);

  // ── Swatch — all rows get their own color ──
  const swatchTd = document.createElement("td");
  swatchTd.className = "legend-swatch";
  const dot = document.createElement("div");
  dot.className = "swatch-dot";
  dot.style.background = colorForLabel(range.label);
  swatchTd.appendChild(dot);
  tr.appendChild(swatchTd);

  // ── Size ──
  const sizeTd = document.createElement("td");
  sizeTd.className = "legend-size";
  sizeTd.textContent = formatSize(range.end - range.start);
  tr.appendChild(sizeTd);

  // ── Name ──
  const nameTd = document.createElement("td");
  nameTd.className = "legend-name";
  nameTd.style.paddingLeft = `${depth * 12 + 4}px`;
  if (hasChildren) {
    nameTd.appendChild(document.createTextNode(range.label + " "));
    const toggle = document.createElement("span");
    toggle.className = "legend-toggle";
    toggle.textContent = "▶";
    nameTd.appendChild(toggle);
  } else {
    nameTd.textContent = range.label;
  }
  tr.appendChild(nameTd);

  // ── Value ──
  const valueTd = document.createElement("td");
  valueTd.className = "legend-value";
  valueTd.textContent = valueStr(range);
  tr.appendChild(valueTd);

  tbody.appendChild(tr);
  const result: HTMLTableRowElement[] = [tr];

  // ── Children ──
  if (hasChildren) {
    const children = (range as Extract<ByteRange, { kind: "group" }>).children;
    const allDescendantRows: HTMLTableRowElement[] = [];
    const directChildRows:   HTMLTableRowElement[] = [];

    for (const child of children) {
      const rows = buildRows(tbody, child, depth + 1, expandedRanges, notifyChange, rowMap, rangeToRowInfo);
      allDescendantRows.push(...rows);
      directChildRows.push(rows[0]!);
      result.push(...rows);
    }

    for (const row of allDescendantRows) row.style.display = "none";

    const toggleEl = nameTd.querySelector<HTMLElement>(".legend-toggle")!;

    rangeToRowInfo.set(range, { directChildRows, allDescendantRows, toggleEl });

    tr.addEventListener("click", () => {
      const isExpanded = directChildRows.length > 0 && directChildRows[0]!.style.display !== "none";
      if (isExpanded) {
        toggleEl.textContent = "▶";
        for (const row of allDescendantRows) {
          row.style.display = "none";
          const innerToggle = row.querySelector<HTMLElement>(".legend-toggle");
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
