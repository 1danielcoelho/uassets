/**
 * Dispatch export data parsing based on the asset class name.
 *
 * Each registered parser receives the BinaryReader positioned at the export's
 * serial offset and should read+annotate its fields. Unrecognized classes fall
 * back to a single "Unparsed export data" annotation covering the whole range.
 */

import { BinaryReader } from "./reader.ts";

type ExportParser = (
  r: BinaryReader,
  classname: string,
  offset: number,
  size: number,
  names: string[],
  fileVersionUE4: number,
) => void;

// Registry of class name → parser function
const PARSERS = new Map<string, ExportParser>();

export function registerParser(className: string, fn: ExportParser): void {
  PARSERS.set(className, fn);
}

export function dispatchExport(
  r: BinaryReader,
  className: string,
  offset: number,
  size: number,
  names: string[],
  fileVersionUE4: number,
): void {
  const parser = PARSERS.get(className);
  if (parser) {
    parser(r, className, offset, size, names, fileVersionUE4);
  } else {
    // Unknown type — annotate the whole block as opaque
    r.annotate(
      `Export Data (${className || "unknown"})`,
      () => r.readBytes(size),
    );
  }
}

// ── Import asset parsers (add more files here as they are implemented) ────────
// import "./assets/static-mesh.ts";
// import "./assets/texture2d.ts";
