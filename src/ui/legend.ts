import type { ByteRange } from "../types.ts";
import { fGuidToString } from "../parser/utils.ts";
import { colorForLabel, type ActiveRange } from "./colors.ts";

// ── Public types ──────────────────────────────────────────────────────────────

export interface LegendHandle {
  setHovered(start: number | null): void;
  onHoverChange: ((start: number | null) => void) | null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function initLegend(
  container: HTMLElement,
  ranges: ByteRange[],
  onColorMapChange?: (ranges: ActiveRange[]) => void,
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

  // ── Rows ──
  const tbody = table.createTBody();
  for (const range of ranges) {
    buildRows(tbody, range, 0, expandedRanges, notifyChange, rowMap);
  }

  // ── Hover state ──
  let hoveredRow: HTMLTableRowElement | null = null;
  let lastHoveredStart: number | null = null;

  const handle: LegendHandle = {
    onHoverChange: null,

    setHovered(start: number | null): void {
      if (hoveredRow) {
        hoveredRow.classList.remove("hovered");
        hoveredRow = null;
      }
      if (start !== null) {
        const rows = rowMap.get(start);
        // Pick the first visible row (groups and their first child share a start offset;
        // only the currently-relevant one will be visible).
        const row = rows?.find(r => r.style.display !== "none") ?? null;
        if (row) {
          row.classList.add("hovered");
          hoveredRow = row;
        }
      }
    },
  };

  // ── Table hover handlers ──
  table.addEventListener("mouseover", (e) => {
    const tr    = (e.target as HTMLElement).closest<HTMLTableRowElement>("tr[data-hrange]");
    const start = tr ? Number(tr.getAttribute("data-hrange")) : null;
    if (start === lastHoveredStart) return;
    lastHoveredStart = start;
    handle.onHoverChange?.(start);
  });

  table.addEventListener("mouseleave", () => {
    if (lastHoveredStart === null) return;
    lastHoveredStart = null;
    handle.onHoverChange?.(null);
  });

  return handle;
}

// ── Active range computation ───────────────────────────────────────────────────

function buildActiveRanges(ranges: ByteRange[], expandedRanges: Set<ByteRange>): ActiveRange[] {
  const result: ActiveRange[] = [];
  for (const range of ranges) {
    if (range.kind === "group" && range.children.length > 0 && expandedRanges.has(range)) {
      result.push(...buildActiveRanges(range.children, expandedRanges));
    } else {
      result.push({ start: range.start, end: range.end, label: range.label });
    }
  }
  return result;
}

function removeDescendantsFromExpanded(range: ByteRange, expandedRanges: Set<ByteRange>): void {
  expandedRanges.delete(range);
  if (range.kind === "group") {
    for (const child of range.children) {
      removeDescendantsFromExpanded(child, expandedRanges);
    }
  }
}

// ── Row builder ───────────────────────────────────────────────────────────────

function buildRows(
  tbody: HTMLTableSectionElement,
  range: ByteRange,
  depth: number,
  expandedRanges: Set<ByteRange>,
  notifyChange: () => void,
  rowMap: Map<number, HTMLTableRowElement[]>,
): HTMLTableRowElement[] {
  const isGroup     = range.kind === "group";
  const hasChildren = isGroup && (range as Extract<ByteRange, { kind: "group" }>).children.length > 0;

  const tr = document.createElement("tr");
  tr.className = hasChildren ? "legend-row legend-group-row" : "legend-row";
  tr.setAttribute("data-hrange", String(range.start));
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
      const rows = buildRows(tbody, child, depth + 1, expandedRanges, notifyChange, rowMap);
      allDescendantRows.push(...rows);
      directChildRows.push(rows[0]!);
      result.push(...rows);
    }

    for (const row of allDescendantRows) row.style.display = "none";

    const toggleEl = nameTd.querySelector<HTMLElement>(".legend-toggle")!;

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

// ── Formatters ────────────────────────────────────────────────────────────────

function valueStr(range: ByteRange): string {
  switch (range.kind) {
    case "int8":  case "int16":  case "int32":
    case "uint8": case "uint16": case "uint32":
    case "float32": case "float64":
      return range.value.toString();
    case "int64": case "uint64":
      return range.value.toString();
    case "bytes": {
      const preview = Array.from(range.value.slice(0, 8))
        .map(b => b.toString(16).padStart(2, "0"))
        .join(" ");
      return range.value.length > 8 ? preview + " …" : preview;
    }
    case "string":
      return range.value.length > 48 ? range.value.slice(0, 47) + "…" : range.value;
    case "guid":
      return fGuidToString(range.value);
    case "group":
      return typeof range.value === "string"
        ? (range.value.length > 48 ? range.value.slice(0, 47) + "…" : range.value)
        : "";
  }
}

function formatSize(n: number): string {
  if (n < 1024) return `${n}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} K`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} M`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} G`;
}
