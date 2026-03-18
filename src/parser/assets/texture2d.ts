/**
 * UTexture2D export parser.
 *
 * Handles parsing the native (non-tagged-property) portions of a Texture2D
 * export: the Export Tail that follows the tagged-property block.
 *
 * Relevant UE source:
 *   Engine/Source/Runtime/Engine/Private/Texture2D.cpp
 *     UTexture2D::Serialize (~line 462)
 *   Engine/Source/Runtime/Engine/Private/Texture.cpp
 *     UTexture::Serialize (~line 1052)
 *   Engine/Source/Runtime/CoreUObject/Private/Serialization/EditorBulkData.cpp
 *     FEditorBulkData::Serialize (~line 1037)
 *
 * Serialization call chain (editor/non-cooked asset):
 *   UObject::Serialize          → tagged properties + PossiblySerializeObjectGuid
 *   UTexture::Serialize         → StripDataFlags + Source.BulkData (FEditorBulkData)
 *   UTexture2D::Serialize       → StripDataFlags + bCooked [+ cooked platform data]
 */

import type { BinaryReader } from "../reader.ts";
import { registerParser } from "../dispatch.ts";
import { parseTaggedProperties } from "../tagged-properties.ts";

// ── FUE5MainStreamObjectVersion constants ─────────────────────────────────────
// Source: Engine/Source/Runtime/Core/Public/UObject/FortniteMainBranchObjectVersion.h
// GUID: 697DD581-E64F41AB-AA4A51EC-BEB7B628
const GUID_FUE5MainStreamObjectVersion = "697DD581-E64F41AB-AA4A51EC-BEB7B628";

// TextureSourceVirtualization = 42 — Source.BulkData uses FEditorBulkData::Serialize
const MSV_TextureSourceVirtualization = 42;

// ── EFlags for FEditorBulkData ────────────────────────────────────────────────
// Source: Engine/Source/Runtime/CoreUObject/Public/Serialization/EditorBulkData.h
const EDITOR_BULK_FLAG_StoredInPackageTrailer = 0x200; // 1 << 9
const EDITOR_BULK_FLAG_IsVirtualized          = 0x010; // 1 << 4
const EDITOR_BULK_FLAG_IsCooked               = 0x100; // 1 << 8

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Serialize a bool as UE4 UBOOL (uint32, 4 bytes). */
function readBool32(r: BinaryReader, label: string): boolean {
  return r.readUint32(label) !== 0;
}

/** FStripDataFlags: 2 bytes (GlobalFlags + ClassFlags). */
interface StripFlags {
  globalFlags: number;
  classFlags:  number;
}

function readStripDataFlags(r: BinaryReader, label = "Strip Data Flags"): StripFlags {
  return r.group(label, () => {
    const globalFlags = r.readUint8("Global Strip Flags");
    const classFlags  = r.readUint8("Class Strip Flags");
    return { globalFlags, classFlags };
  });
}

function isEditorDataStripped(sf: StripFlags): boolean { return (sf.globalFlags & 1) !== 0; }

/** Read FGuid (4 × uint32 LE) and return as formatted string. */
function readFGuid(r: BinaryReader, label: string): string {
  return r.group(label, () => {
    const a = r.readUint32("A");
    const b = r.readUint32("B");
    const c = r.readUint32("C");
    const d = r.readUint32("D");
    return [a, b, c, d].map(n => n.toString(16).padStart(8, "0").toUpperCase()).join("-");
  });
}

// ── FEditorBulkData reference ─────────────────────────────────────────────────

/**
 * Parse an FEditorBulkData reference (persistent/serialized form).
 * Source: EditorBulkData.cpp ~line 1037, Serialize() persistent path.
 *
 * Layout:
 *   uint32  EFlags         (LE)
 *   FGuid   BulkDataId     (4 × uint32 LE = 16 bytes)
 *   byte[20] PayloadContentId  (FIoHash = first 20 bytes of Blake3-256)
 *   int64   PayloadSize    (LE)
 *   [if NOT StoredInPackageTrailer AND NOT IsVirtualized AND NOT IsCooked]:
 *     int64   OffsetInFile (LE)
 */
function readEditorBulkDataRef(r: BinaryReader, label: string): void {
  r.group(label, () => {
    const flags = r.readUint32("EFlags");

    // Decode flag bits for display
    const inTrailer    = (flags & EDITOR_BULK_FLAG_StoredInPackageTrailer) !== 0;
    const isVirtualized = (flags & EDITOR_BULK_FLAG_IsVirtualized) !== 0;
    const isCooked     = (flags & EDITOR_BULK_FLAG_IsCooked) !== 0;

    readFGuid(r, "BulkDataId");
    r.readBytes(20, "PayloadContentId (FIoHash)");
    r.readInt64("PayloadSize");

    // OffsetInFile is only written when the payload is stored inline (not in
    // PackageTrailer, not virtualized, not cooked).
    if (!inTrailer && !isVirtualized && !isCooked) {
      r.readInt64("OffsetInFile");
    }
  });
}

// ── Export Tail ───────────────────────────────────────────────────────────────

/**
 * Parse the Export Tail of a UTexture2D export.
 *
 * The tail begins right after scriptEnd (after tagged properties).
 * UObject::Serialize writes PossiblySerializeObjectGuid here (before the
 * annotation was moved to a separate system). Then UTexture::Serialize writes
 * its strip flags and Source.BulkData, and UTexture2D::Serialize writes its
 * own strip flags, bCooked, and optional cooked platform data.
 *
 * Non-cooked layout (60 bytes for T_shapes.uasset):
 *   pos  0- 3: PossiblySerializeObjectGuid (bool32=0, no lazy GUID)
 *   pos  4- 5: StripDataFlags (UTexture level)
 *   pos  6- 9: FEditorBulkData.EFlags (uint32 LE)
 *   pos 10-25: FEditorBulkData.BulkDataId (FGuid, 16 bytes)
 *   pos 26-45: FEditorBulkData.PayloadContentId (FIoHash, 20 bytes)
 *   pos 46-53: FEditorBulkData.PayloadSize (int64 LE)
 *   pos 54-55: StripDataFlags (UTexture2D level)
 *   pos 56-59: bCooked (bool32)
 *   Total = 60 bytes
 */
function parseTexture2DTail(
  r: BinaryReader,
  endOffset: number,
  customVersions: ReadonlyMap<string, number>,
): void {
  const mainStreamVer = customVersions.get(GUID_FUE5MainStreamObjectVersion) ?? 0;
  const hasVirtualizedBulkData = mainStreamVer >= MSV_TextureSourceVirtualization;

  r.group("Native Tail", () => {
    // 1. UObject::PossiblySerializeObjectGuid (written after tagged properties)
    r.group("Object GUID (Lazy Ptr)", () => {
      const hasGuid = readBool32(r, "Has GUID");
      if (hasGuid) readFGuid(r, "GUID");
    });

    // 2. UTexture::Serialize — StripDataFlags + Source.BulkData
    const textureStripFlags = readStripDataFlags(r, "Strip Data Flags (UTexture)");

    if (!isEditorDataStripped(textureStripFlags)) {
      if (hasVirtualizedBulkData) {
        // Modern path (UE5 >= TextureSourceVirtualization=42): FEditorBulkData::Serialize
        readEditorBulkDataRef(r, "Source Bulk Data");
      } else {
        // Older path: FByteBulkData — read as opaque remainder for now
        // This branch applies to pre-5.x assets; our test assets are all UE5
        const remaining = endOffset - r.pos - 6; // leave room for UTexture2D tail (2+4 bytes)
        if (remaining > 0) {
          r.readBytes(remaining, "Source Bulk Data (FByteBulkData, opaque)");
        }
      }
    }

    // 3. UTexture2D::Serialize — StripDataFlags + bCooked [+ cooked data]
    readStripDataFlags(r, "Strip Data Flags (UTexture2D)");
    const bCooked = readBool32(r, "bCooked");

    if (bCooked) {
      // Cooked path: bSerializeMipData (bool32) + SerializeCookedPlatformData
      // SerializeCookedPlatformData is complex (FTexturePlatformData per-mip).
      // Read as opaque for now.
      readBool32(r, "bSerializeMipData");
      const remaining = endOffset - r.pos;
      if (remaining > 0) {
        r.readBytes(remaining, "Cooked Platform Data (opaque)");
      }
    }
  });
}

// ── Main entry point ──────────────────────────────────────────────────────────

function parseTexture2DExport(
  r: BinaryReader,
  _classname: string,
  offset: number,
  size: number,
  names: string[],
  _fileVersionUE4: number,
  fileVersionUE5: number,
  scriptStart: number,
  scriptEnd: number,
  customVersions: ReadonlyMap<string, number>,
): void {
  const absScriptStart = offset + scriptStart;
  const absScriptEnd   = offset + scriptEnd;
  const absEnd         = offset + size;

  // Export Header: native data before tagged properties (if any)
  if (scriptStart > 0) {
    r.seek(offset);
    r.readBytes(scriptStart, "Export Header");
  }

  // Tagged Properties
  if (absScriptEnd > absScriptStart) {
    r.seek(absScriptStart);
    r.group("Properties", () => {
      parseTaggedProperties(r, names, absScriptEnd, fileVersionUE5);
    });
  }

  // Export Tail: native data after tagged properties
  if (absEnd > absScriptEnd) {
    r.seek(absScriptEnd);
    parseTexture2DTail(r, absEnd, customVersions);
  }
}

// Register for all texture classes that share the same serialize chain
registerParser("Texture2D",                parseTexture2DExport);
registerParser("TextureCube",              parseTexture2DExport);
registerParser("Texture2DArray",           parseTexture2DExport);
registerParser("VolumeTexture",            parseTexture2DExport);
registerParser("TextureRenderTarget2D",    parseTexture2DExport);
registerParser("TextureLightProfile",      parseTexture2DExport);
