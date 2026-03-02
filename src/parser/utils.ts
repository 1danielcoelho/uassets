/**
 * Shared utility functions for UE binary parsing.
 */

import type { FGuid, FEngineVersion, FObjectImport, FObjectExport } from "./types.ts";

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
