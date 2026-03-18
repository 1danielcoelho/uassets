/**
 * UWorld export parser.
 *
 * Handles parsing the native (non-tagged-property) portions of a UWorld
 * export: the Export Tail that follows the tagged-property block.
 *
 * Relevant UE source:
 *   Engine/Source/Runtime/Engine/Private/World.cpp
 *     UWorld::Serialize (~line 865)
 *   Engine/Source/Runtime/CoreUObject/Private/UObject/Obj.cpp
 *     UObject::Serialize (~line 1646) — tagged props + PossiblySerializeObjectGuid
 *
 * Serialization call chain:
 *   UObject::Serialize  → tagged properties + PossiblySerializeObjectGuid (bool32)
 *   UWorld::Serialize   → PersistentLevel (FPackageIndex)
 *                         [if UE4Ver < VER_UE4_ADD_EDITOR_VIEWS:  4× FLevelViewportInfo (skipped for modern)]
 *                         [if UE4Ver < VER_UE4_REMOVE_SAVEGAMESUMMARY: DummyObject (skipped for modern)]
 *                         [if !IsLoading && !IsSaving: runtime refs (skipped for persistent saves)]
 *                         ExtraReferencedObjects (TArray<UObject*> — FPackageIndex per element)
 *                         StreamingLevels        (TArray<ULevelStreaming*> — FPackageIndex per element)
 *
 * Non-cooked editor layout (16 bytes for MyMap.umap):
 *   pos  0- 3: PossiblySerializeObjectGuid (bool32=0)
 *   pos  4- 7: PersistentLevel             (FPackageIndex = int32 = 21 → Export[20])
 *   pos  8-11: ExtraReferencedObjects      (int32 count = 0)
 *   pos 12-15: StreamingLevels             (int32 count = 0)
 *   Total = 16 bytes
 *
 * Version notes:
 *   VER_UE4_ADD_EDITOR_VIEWS and VER_UE4_REMOVE_SAVEGAMESUMMARY are very old
 *   UE4 thresholds (well below fileVersionUE4=522 used by UE5 assets). For any
 *   modern UE5 asset both `UEVer() < X` conditions are always false and those
 *   blocks are never serialized.
 *
 *   StreamingLevels: in the editor save path (IsPersistent && IsSaving), UE
 *   writes only non-RF_Transient streaming levels as `PersistedStreamingLevels`.
 *   For our test asset there are none (count=0), so the array is just the count.
 */

import type { BinaryReader } from "../reader.ts";
import { registerParser } from "../dispatch.ts";
import { parseTaggedProperties } from "../tagged-properties.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function readBool32(r: BinaryReader, label: string): boolean {
  return r.readUint32(label) !== 0;
}

function readFGuid(r: BinaryReader, label: string): string {
  return r.group(label, () => {
    const a = r.readUint32("A");
    const b = r.readUint32("B");
    const c = r.readUint32("C");
    const d = r.readUint32("D");
    return [a, b, c, d].map(n => n.toString(16).padStart(8, "0").toUpperCase()).join("-");
  });
}

/**
 * Read a FPackageIndex (int32) and annotate it.
 * Positive = export (1-based), negative = import (−1-based), 0 = null.
 */
function readPackageIndex(r: BinaryReader, label: string): number {
  return r.readInt32(label);
}

/**
 * Read a TArray<UObject*> serialized as FPackageIndex per element.
 * Format: int32 count, then count × int32 FPackageIndex.
 */
function readObjectArray(r: BinaryReader, label: string): void {
  r.group(label, () => {
    const count = r.readInt32("Count");
    for (let i = 0; i < count; i++) {
      readPackageIndex(r, `[${i}]`);
    }
  });
}

// ── UWorld Export Tail ────────────────────────────────────────────────────────

/**
 * Parse the Export Tail of a UWorld export.
 */
function parseWorldTail(r: BinaryReader): void {
  r.group("Native Tail", () => {
    // 1. UObject::PossiblySerializeObjectGuid
    r.group("Object GUID (Lazy Ptr)", () => {
      const hasGuid = readBool32(r, "Has GUID");
      if (hasGuid) readFGuid(r, "GUID");
    });

    // 2. UWorld::Serialize — PersistentLevel (FPackageIndex)
    //    The persistent level is always the first export in a .umap file.
    readPackageIndex(r, "PersistentLevel");

    // 3. UWorld::Serialize — ExtraReferencedObjects (TArray<UObject*>)
    readObjectArray(r, "ExtraReferencedObjects");

    // 4. UWorld::Serialize — StreamingLevels (TArray<ULevelStreaming*>)
    //    Editor save path writes only non-Transient streaming levels.
    readObjectArray(r, "StreamingLevels");
  });
}

// ── Main entry point ──────────────────────────────────────────────────────────

function parseWorldExport(
  r: BinaryReader,
  _classname: string,
  offset: number,
  size: number,
  names: string[],
  _fileVersionUE4: number,
  fileVersionUE5: number,
  scriptStart: number,
  scriptEnd: number,
  _customVersions: ReadonlyMap<string, number>,
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
    parseWorldTail(r);
  }
}

// Register parsers
registerParser("World", parseWorldExport);
