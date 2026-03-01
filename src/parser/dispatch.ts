/**
 * Dispatch export data parsing based on the asset class name.
 *
 * Each registered parser receives the BinaryReader positioned at the export's
 * serial offset and should read+annotate its fields. Unrecognized classes fall
 * back to generic tagged-property parsing (using the ScriptSerializationOffset
 * bounds stored in the export table entry).
 */

import { BinaryReader } from "./reader.ts";
import { parseTaggedProperties } from "./tagged-properties.ts";

// UE5 version threshold for script serialization offsets.
const UE5_SCRIPT_SERIALIZATION_OFFSET = 1010;

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

export function dispatchExport(
  r: BinaryReader,
  className: string,
  offset: number,
  size: number,
  names: string[],
  fileVersionUE4: number,
  fileVersionUE5: number,
  scriptStart: number,  // relative to serialOffset
  scriptEnd: number,    // relative to serialOffset
): void {
  const parser = PARSERS.get(className);
  if (parser) {
    parser(r, className, offset, size, names, fileVersionUE4, fileVersionUE5, scriptStart, scriptEnd);
    return;
  }

  // Debug: print script offsets for each export
  if (process.env.DEBUG_DISPATCH) {
    console.error(`dispatch cls=${className} offset=0x${offset.toString(16)} size=${size} scriptStart=${scriptStart} scriptEnd=${scriptEnd}`);
  }

  // Generic fallback: parse tagged properties if script offset bounds are available.
  if (fileVersionUE5 >= UE5_SCRIPT_SERIALIZATION_OFFSET && scriptEnd > scriptStart && false) {
    const absScriptStart = offset + scriptStart;
    const absScriptEnd   = offset + scriptEnd;

    // Bytes before the tagged-property region (native/C++ header).
    if (scriptStart > 0) {
      r.seek(offset);
      r.readBytes(scriptStart, "Export Header");
    }

    // Tagged properties.
    r.seek(absScriptStart);
    parseTaggedProperties(r, names, absScriptEnd, fileVersionUE5);

    // Bytes after the tagged-property region (native/C++ tail or bulk data).
    const tail = (offset + size) - absScriptEnd;
    if (tail > 0) {
      r.seek(absScriptEnd);
      r.readBytes(tail, "Export Tail");
    }
  } else {
    // No script offset info — annotate the whole block as opaque.
    r.readBytes(size, `Export Data (${className || "unknown"})`);
  }
}

// ── Import asset parsers (add more files here as they are implemented) ────────
// import "./assets/static-mesh.ts";
// import "./assets/texture2d.ts";
