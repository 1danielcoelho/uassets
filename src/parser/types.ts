/**
 * UE serialization primitive types.
 *
 * Read implementations live on BinaryReader as instance methods.
 */

// ── FGuid ─────────────────────────────────────────────────────────────────────

export interface FGuid {
  a: number;
  b: number;
  c: number;
  d: number;
}

// ── FEngineVersion ─────────────────────────────────────────────────────────────

export interface FEngineVersion {
  major: number;
  minor: number;
  patch: number;
  changelist: number;
  branch: string;
}

// ── Custom version entry ──────────────────────────────────────────────────────

export interface FCustomVersion {
  guid: FGuid;
  version: number;
}

// ── FGenerationInfo ───────────────────────────────────────────────────────────

export interface FGenerationInfo {
  exportCount: number;
  nameCount: number;
}

// ── Compressed chunk (legacy, present in older formats) ───────────────────────

export interface FCompressedChunk {
  uncompressedOffset: number;
  uncompressedSize: number;
  compressedOffset: number;
  compressedSize: number;
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
  // UE5 >= 1006
  isInherited: boolean;
  // UE5 >= 1010 (relative to serialOffset)
  scriptSerializationStartOffset: bigint;
  scriptSerializationEndOffset: bigint;
}

// ── FObjectImport ─────────────────────────────────────────────────────────────

export interface FObjectImport {
  classPackage: number;  // name index
  className: number;     // name index
  outerIndex: number;
  objectName: number;    // name index
  // UE5 optional: package name
}
