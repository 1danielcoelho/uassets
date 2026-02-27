/**
 * UE serialization primitives.
 *
 * Each function reads the corresponding UE type from a BinaryReader and returns
 * the decoded value. These are intentionally low-level — callers wrap them in
 * reader.annotate() as needed.
 */

import { BinaryReader } from "./reader.ts";

// ── FString ───────────────────────────────────────────────────────────────────

/**
 * UE FString on disk:
 *   int32  length  (positive = UTF-8/Latin-1, negative = UTF-16LE, 0 = "None"/empty)
 *   bytes  [length] for UTF-8, or [abs(length)*2] for UTF-16LE
 *
 * The trailing null character is included in `length` but we strip it from the
 * returned string.
 */
export function readFString(r: BinaryReader): string {
  const len = r.readInt32();
  if (len === 0) return "";
  if (len > 0) {
    // UTF-8 / Latin-1
    const bytes = r.readBytes(len);
    // Remove null terminator if present
    const end = bytes[len - 1] === 0 ? len - 1 : len;
    return new TextDecoder("utf-8").decode(bytes.subarray(0, end));
  } else {
    // UTF-16LE (len is negative; each code unit is 2 bytes)
    const charCount = -len;
    const bytes = r.readBytes(charCount * 2);
    // Remove null terminator (last 2 bytes = 0x0000)
    const end = (bytes[charCount * 2 - 1] === 0 && bytes[charCount * 2 - 2] === 0)
      ? (charCount - 1) * 2
      : charCount * 2;
    return new TextDecoder("utf-16le").decode(bytes.subarray(0, end));
  }
}

// ── FGuid ─────────────────────────────────────────────────────────────────────

export interface FGuid {
  a: number;
  b: number;
  c: number;
  d: number;
}

/** UE FGuid: four uint32s stored as A-B-C-D. */
export function readFGuid(r: BinaryReader): FGuid {
  return { a: r.readUint32(), b: r.readUint32(), c: r.readUint32(), d: r.readUint32() };
}

export function fGuidToString(g: FGuid): string {
  return [g.a, g.b, g.c, g.d]
    .map(n => n.toString(16).padStart(8, "0").toUpperCase())
    .join("-");
}

// ── FEngineVersion ─────────────────────────────────────────────────────────────

export interface FEngineVersion {
  major: number;
  minor: number;
  patch: number;
  changelist: number;
  branch: string;
}

/** UE FEngineVersion: major(u16) minor(u16) patch(u16) changelist(u32) branch(FString). */
export function readFEngineVersion(r: BinaryReader): FEngineVersion {
  const major = r.readUint16();
  const minor = r.readUint16();
  const patch = r.readUint16();
  const changelist = r.readUint32();
  const branch = readFString(r);
  return { major, minor, patch, changelist, branch };
}

export function fEngineVersionToString(v: FEngineVersion): string {
  const cl = v.changelist ? ` (CL ${v.changelist})` : "";
  const br = v.branch ? ` [${v.branch}]` : "";
  return `${v.major}.${v.minor}.${v.patch}${cl}${br}`;
}

// ── Custom version entry ──────────────────────────────────────────────────────

export interface FCustomVersion {
  guid: FGuid;
  version: number;
}

export function readFCustomVersion(r: BinaryReader): FCustomVersion {
  return { guid: readFGuid(r), version: r.readInt32() };
}

// ── FGenerationInfo ───────────────────────────────────────────────────────────

export interface FGenerationInfo {
  exportCount: number;
  nameCount: number;
}

export function readFGenerationInfo(r: BinaryReader): FGenerationInfo {
  return { exportCount: r.readInt32(), nameCount: r.readInt32() };
}

// ── Compressed chunk (legacy, present in older formats) ───────────────────────

export interface FCompressedChunk {
  uncompressedOffset: number;
  uncompressedSize: number;
  compressedOffset: number;
  compressedSize: number;
}

export function readFCompressedChunk(r: BinaryReader): FCompressedChunk {
  return {
    uncompressedOffset: r.readInt32(),
    uncompressedSize:   r.readInt32(),
    compressedOffset:   r.readInt32(),
    compressedSize:     r.readInt32(),
  };
}

// ── FObjectExport ─────────────────────────────────────────────────────────────

export interface FObjectExport {
  /** Index into imports/exports table for the class (negative = import, positive = export, 0 = UClass). */
  classIndex: number;
  superIndex: number;
  templateIndex: number;   // UE4.14+
  outerIndex: number;
  objectName: number;      // index into names table
  objectFlags: number;
  serialSize: bigint;
  serialOffset: bigint;
  forcedExport: boolean;
  notForClient: boolean;
  notForServer: boolean;
  packageGuid: FGuid;
  packageFlags: number;
  notAlwaysLoadedForEditorGame: boolean;  // UE4.15+
  isAsset: boolean;                       // UE4.17+
  generatePublicHash: boolean;            // UE5.1+
  firstExportDependency: number;
  serializationBeforeSerializationDependencies: number;
  createBeforeSerializationDependencies: number;
  serializationBeforeCreateDependencies: number;
  createBeforeCreateDependencies: number;
}

// ── FObjectImport ─────────────────────────────────────────────────────────────

export interface FObjectImport {
  classPackage: number;  // name index
  className: number;     // name index
  outerIndex: number;
  objectName: number;    // name index
  // UE5 optional: package name
}

// ── Array helper ──────────────────────────────────────────────────────────────

/** Read a TArray<T>: int32 count, then count × T. */
export function readArray<T>(r: BinaryReader, readItem: (r: BinaryReader) => T): T[] {
  const count = r.readInt32();
  const result: T[] = [];
  for (let i = 0; i < count; i++) {
    result.push(readItem(r));
  }
  return result;
}
