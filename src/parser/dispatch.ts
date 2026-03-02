/**
 * Class-specific export parser registry.
 *
 * Each registered parser handles a specific UObject class (e.g. UStaticMesh,
 * UTexture2D). Unrecognized classes are handled generically by the caller.
 *
 * Register parsers by importing their module, which calls registerParser().
 * The main parser (parser.ts) calls dispatchExport() and falls back to
 * generic tagged-property parsing when false is returned.
 */

import { BinaryReader } from "./reader.ts";

type ExportParser = (
  r: BinaryReader,
  classname: string,
  offset: number,
  size: number,
  names: string[],
  fileVersionUE4: number,
  fileVersionUE5: number,
  scriptStart: number,
  scriptEnd: number,
) => void;

// Registry of class name → parser function
const PARSERS = new Map<string, ExportParser>();

export function registerParser(className: string, fn: ExportParser): void {
  PARSERS.set(className, fn);
}

/**
 * Attempt to dispatch to a class-specific parser.
 * Returns true if a registered parser handled the export, false otherwise.
 */
export function dispatchExport(
  r: BinaryReader,
  className: string,
  offset: number,
  size: number,
  names: string[],
  fileVersionUE4: number,
  fileVersionUE5: number,
  scriptStart: number,
  scriptEnd: number,
): boolean {
  const parser = PARSERS.get(className);
  if (parser) {
    parser(r, className, offset, size, names, fileVersionUE4, fileVersionUE5, scriptStart, scriptEnd);
    return true;
  }
  return false;
}

// ── Import asset parsers (add more files here as they are implemented) ────────
// import "./assets/static-mesh.ts";
// import "./assets/texture2d.ts";
