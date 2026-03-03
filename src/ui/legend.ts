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

  for (let i = 0; i < ranges.length; i++) {
    buildRows(table, ranges[i]!, PALETTE[i % PALETTE.length]!, 0);
  }
}

// ── Row builder ───────────────────────────────────────────────────────────────

function buildRows(
  table: HTMLTableElement,
  range: ByteRange,
  color: string,
  depth: number,
): HTMLTableRowElement[] {
  const isGroup    = range.kind === "group";
  const hasChildren = isGroup && (range as Extract<ByteRange, { kind: "group" }>).children.length > 0;

  const tr = document.createElement("tr");
  tr.className = "legend-row";

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

  // ── Name (with indent + optional toggle) ──
  const nameTd = document.createElement("td");
  nameTd.className = "legend-name";
  // Each depth level adds 12px; non-toggle items add 14px more to align text with toggled items
  const baseIndent = depth * 12 + 4;
  if (hasChildren) {
    nameTd.style.paddingLeft = `${baseIndent}px`;
    const toggle = document.createElement("span");
    toggle.className = "legend-toggle";
    toggle.textContent = "▶";
    nameTd.appendChild(toggle);
    nameTd.appendChild(document.createTextNode("\u00a0" + range.label));
  } else {
    nameTd.style.paddingLeft = `${baseIndent + 14}px`;
    nameTd.textContent = range.label;
  }
  tr.appendChild(nameTd);

  // ── Value ──
  const valueTd = document.createElement("td");
  valueTd.className = "legend-value";
  valueTd.textContent = valueStr(range);
  tr.appendChild(valueTd);

  table.appendChild(tr);
  const result: HTMLTableRowElement[] = [tr];

  // ── Children ──
  if (hasChildren) {
    const children = (range as Extract<ByteRange, { kind: "group" }>).children;
    const descendantRows: HTMLTableRowElement[] = [];

    for (const child of children) {
      const rows = buildRows(table, child, color, depth + 1);
      descendantRows.push(...rows);
      result.push(...rows);
    }

    // All groups start collapsed — hide descendants immediately
    for (const row of descendantRows) row.style.display = "none";

    const toggleEl = nameTd.querySelector<HTMLElement>(".legend-toggle")!;
    let expanded = false;
    toggleEl.addEventListener("click", (e) => {
      e.stopPropagation();
      expanded = !expanded;
      toggleEl.textContent = expanded ? "▼" : "▶";
      for (const row of descendantRows) {
        row.style.display = expanded ? "" : "none";
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
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
