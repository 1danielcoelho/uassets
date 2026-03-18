/**
 * Shared utility functions for UE binary parsing.
 */

import type { BinaryReader } from "./reader.ts";
import type { FGuid, FEngineVersion, FObjectImport, FObjectExport } from "./types.ts";
import { parseTaggedProperties } from "./tagged-properties.ts";

export function fGuidToString(g: FGuid): string {
  return [g.a, g.b, g.c, g.d]
    .map(n => n.toString(16).padStart(8, "0").toUpperCase())
    .join("-");
}

export function fEngineVersionToString(v: FEngineVersion): string {
  const cl = v.changelist ? ` (CL ${v.changelist})` : "";
  const br = v.branch ? ` [${v.branch}]` : "";
  return `${v.major}.${v.minor}.${v.patch}${cl}${br}`;
}

export function resolveName(names: string[], index: number): string {
  if (index < 0 || index >= names.length) return `<name#${index}>`;
  return names[index]!;
}

/**
 * Resolve a class name from an object index (positive = export, negative = import, 0 = UClass).
 * Object indices are 1-based (UE convention); 0 means "this package" / UClass.
 */
export function resolveClass(
  imports: FObjectImport[],
  exports: FObjectExport[],
  names: string[],
  classIndex: number,
): string {
  if (classIndex === 0) return "UClass";
  if (classIndex < 0) {
    const imp = imports[-classIndex - 1];
    if (!imp) return `<import#${classIndex}>`;
    return resolveName(names, imp.objectName);
  }
  const exp = exports[classIndex - 1];
  if (!exp) return `<export#${classIndex}>`;
  return resolveName(names, exp.objectName);
}

// ── Asset parser shared helpers ───────────────────────────────────────────────

/** Shared GUID constants for UE custom version registries. */
export const GUID_FRenderingObjectVersion          = "12F88B9F-88754AFC-A67CD90C-383ABD29";
export const GUID_FEditorObjectVersion             = "E4B068ED-F49442E9-A231DA0B-2E46BB41";
export const GUID_FFortniteMainBranchObjectVersion = "601D1886-AC644F84-AA16D3DE-0DEAC7D6";
export const GUID_FUE5ReleaseStreamObjectVersion   = "D89B5E42-24BD4D46-8412ACA8-DF641779";
export const GUID_FUE5MainStreamObjectVersion      = "697DD581-E64F41AB-AA4A51EC-BEB7B628";

/** Read a bool serialized as UE's UBOOL (uint32). */
export function readBool32(r: BinaryReader, label: string): boolean {
  return r.readUint32(label) !== 0;
}

/** Read FGuid as a group with annotated A/B/C/D fields, returned as a formatted string. */
export function readFGuid(r: BinaryReader, label: string): string {
  return r.group(label, () => {
    const a = r.readUint32("A");
    const b = r.readUint32("B");
    const c = r.readUint32("C");
    const d = r.readUint32("D");
    return [a, b, c, d].map(n => n.toString(16).padStart(8, "0").toUpperCase()).join("-");
  });
}

/** Read FName as two int32s (name index + instance number). */
export function readFName(r: BinaryReader, names: string[], label: string): string {
  return r.group(label, () => {
    const idx    = r.readInt32("Name Index");
    const number = r.readInt32("Name Number");
    const base   = idx >= 0 && idx < names.length ? names[idx]! : `<name#${idx}>`;
    return number > 0 ? `${base}_${number - 1}` : base;
  });
}

/** Read a FPackageIndex (int32): positive = export (1-based), negative = import (1-based), 0 = null. */
export function readPackageIndex(r: BinaryReader, label: string): number {
  return r.readInt32(label);
}

/** FStripDataFlags: 2 bytes of strip flag bitfields. */
export interface StripFlags { globalFlags: number; classFlags: number; }

export function readStripDataFlags(r: BinaryReader, label = "Strip Data Flags"): StripFlags {
  return r.group(label, () => ({
    globalFlags: r.readUint8("Global Strip Flags"),
    classFlags:  r.readUint8("Class Strip Flags"),
  }));
}

export function isEditorDataStripped(sf: StripFlags): boolean { return (sf.globalFlags & 1) !== 0; }
export function isAVDataStripped(sf: StripFlags):     boolean { return (sf.globalFlags & 2) !== 0; }
export function isClassDataStripped(sf: StripFlags, bit: number): boolean { return (sf.classFlags & bit) !== 0; }

/**
 * Read the PossiblySerializeObjectGuid block present at the start of every UObject's native tail.
 * Format: bool32 hasGuid [+ FGuid if true].
 */
export function readObjectGuid(r: BinaryReader): void {
  r.group("Object GUID (Lazy Ptr)", () => {
    const hasGuid = readBool32(r, "Has GUID");
    if (hasGuid) readFGuid(r, "GUID");
  });
}

/**
 * Standard export entry-point scaffold: optional Export Header + tagged Properties + tail.
 * The tail function receives the absolute end offset of the export.
 */
export function parseExport(
  r: BinaryReader,
  offset: number,
  size: number,
  names: string[],
  fileVersionUE5: number,
  scriptStart: number,
  scriptEnd: number,
  parseTailFn: (absEnd: number) => void,
): void {
  const absScriptStart = offset + scriptStart;
  const absScriptEnd   = offset + scriptEnd;
  const absEnd         = offset + size;

  if (scriptStart > 0) {
    r.seek(offset);
    r.readBytes(scriptStart, "Export Header");
  }

  if (absScriptEnd > absScriptStart) {
    r.seek(absScriptStart);
    r.group("Properties", () => {
      parseTaggedProperties(r, names, absScriptEnd, fileVersionUE5);
    });
  }

  if (absEnd > absScriptEnd) {
    r.seek(absScriptEnd);
    parseTailFn(absEnd);
  }
}
