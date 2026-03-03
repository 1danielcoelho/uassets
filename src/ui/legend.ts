import type { ByteRange } from "../types.ts";
import { fGuidToString } from "../parser/utils.ts";

// ── Palette (keep in sync with hex-view.ts) ───────────────────────────────────

const PALETTE = [
  "#1c3d5a", // blue
  "#1a4728", // green
  "#4a1f2e", // crimson
  "#3d2c0e", // amber
  "#28184a", // purple
  "#0e3a3a", // teal
  "#4a3a0e", // gold
  "#3a0e3a", // magenta
  "#0e2a4a", // navy
  "#2a4a0e", // lime
  "#4a280e", // rust
  "#0e3a28", // jade
];

// ── Public API ────────────────────────────────────────────────────────────────

export function initLegend(container: HTMLElement, ranges: ByteRange[]): void {
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

  // ── Rows ──
  const tbody = table.createTBody();
  for (let i = 0; i < ranges.length; i++) {
    buildRows(tbody, ranges[i]!, PALETTE[i % PALETTE.length]!, 0);
  }
}

// ── Row builder ───────────────────────────────────────────────────────────────

function buildRows(
  tbody: HTMLTableSectionElement,
  range: ByteRange,
  color: string,
  depth: number,
): HTMLTableRowElement[] {
  const isGroup     = range.kind === "group";
  const hasChildren = isGroup && (range as Extract<ByteRange, { kind: "group" }>).children.length > 0;

  const tr = document.createElement("tr");
  tr.className = hasChildren ? "legend-row legend-group-row" : "legend-row";

  // ── Swatch ──
  const swatchTd = document.createElement("td");
  swatchTd.className = "legend-swatch";
  if (depth === 0) {
    const dot = document.createElement("div");
    dot.className = "swatch-dot";
    dot.style.background = color;
    swatchTd.appendChild(dot);
  }
  tr.appendChild(swatchTd);

  // ── Size ──
  const sizeTd = document.createElement("td");
  sizeTd.className = "legend-size";
  sizeTd.textContent = formatSize(range.end - range.start);
  tr.appendChild(sizeTd);

  // ── Name (with indent; toggle goes after label for groups) ──
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
      const rows = buildRows(tbody, child, color, depth + 1);
      allDescendantRows.push(...rows);
      directChildRows.push(rows[0]!); // first row is the child's own <tr>
      result.push(...rows);
    }

    // All groups start collapsed
    for (const row of allDescendantRows) row.style.display = "none";

    const toggleEl = nameTd.querySelector<HTMLElement>(".legend-toggle")!;

    // Entire row is the click target.
    // State is derived from the DOM so that a parent collapsing (hiding our row)
    // and re-expanding never leaves us with a stale expanded=true closure variable.
    tr.addEventListener("click", () => {
      const isExpanded = directChildRows.length > 0 && directChildRows[0]!.style.display !== "none";
      if (isExpanded) {
        // Collapse: hide ALL descendants and reset their toggle icons to ▶
        toggleEl.textContent = "▶";
        for (const row of allDescendantRows) {
          row.style.display = "none";
          const innerToggle = row.querySelector<HTMLElement>(".legend-toggle");
          if (innerToggle) innerToggle.textContent = "▶";
        }
      } else {
        // Expand: show only direct children; each inner group manages its own state
        toggleEl.textContent = "▼";
        for (const row of directChildRows) row.style.display = "";
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
