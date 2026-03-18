/**
 * UTexture2D export parser.
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
import { flagsStr, EEditorBulkDataFlags } from "../enums.ts";
import { registerParser } from "../dispatch.ts";
import {
  GUID_FUE5MainStreamObjectVersion,
  readBool32, readFGuid, readStripDataFlags, isEditorDataStripped,
  readObjectGuid, parseExport,
} from "../utils.ts";

// FUE5MainStreamObjectVersion::TextureSourceVirtualization = 42
// Source.BulkData uses FEditorBulkData::Serialize at and above this version.
const MSV_TextureSourceVirtualization = 42;

// EFlags bits for FEditorBulkData
// Source: Engine/Source/Runtime/CoreUObject/Public/Serialization/EditorBulkData.h
const EDITOR_BULK_FLAG_StoredInPackageTrailer = 0x200;
const EDITOR_BULK_FLAG_IsVirtualized          = 0x010;
const EDITOR_BULK_FLAG_IsCooked               = 0x100;

// ── FEditorBulkData reference ─────────────────────────────────────────────────

/**
 * Parse an FEditorBulkData reference (persistent/serialized form).
 * Source: EditorBulkData.cpp ~line 1037, Serialize() persistent path.
 *
 * Layout:
 *   uint32   EFlags
 *   FGuid    BulkDataId     (16 bytes)
 *   byte[20] PayloadContentId  (FIoHash — first 20 bytes of Blake3-256)
 *   int64    PayloadSize
 *   [if NOT StoredInPackageTrailer AND NOT IsVirtualized AND NOT IsCooked]:
 *     int64  OffsetInFile
 */
function readEditorBulkDataRef(r: BinaryReader, label: string): void {
  r.group(label, () => {
    const flags = r.readUint32("EFlags");
    r.setLastDisplay(flagsStr(flags, EEditorBulkDataFlags));
    const inTrailer     = (flags & EDITOR_BULK_FLAG_StoredInPackageTrailer) !== 0;
    const isVirtualized = (flags & EDITOR_BULK_FLAG_IsVirtualized) !== 0;
    const isCooked      = (flags & EDITOR_BULK_FLAG_IsCooked) !== 0;
    readFGuid(r, "BulkDataId");
    r.readBytes(20, "PayloadContentId (FIoHash)");
    r.readInt64("PayloadSize");
    if (!inTrailer && !isVirtualized && !isCooked) {
      r.readInt64("OffsetInFile");
    }
  });
}

// ── Export tail ───────────────────────────────────────────────────────────────

/**
 * Parse the Export Tail of a UTexture2D export.
 *
 * Non-cooked layout (60 bytes for T_shapes.uasset):
 *   0- 3: PossiblySerializeObjectGuid (bool32=0)
 *   4- 5: StripDataFlags (UTexture)
 *   6- 9: FEditorBulkData.EFlags
 *  10-25: FEditorBulkData.BulkDataId (FGuid, 16B)
 *  26-45: FEditorBulkData.PayloadContentId (FIoHash, 20B)
 *  46-53: FEditorBulkData.PayloadSize (int64)
 *  54-55: StripDataFlags (UTexture2D)
 *  56-59: bCooked (bool32)
 */
function parseTexture2DTail(
  r: BinaryReader,
  endOffset: number,
  customVersions: ReadonlyMap<string, number>,
): void {
  const mainStreamVer = customVersions.get(GUID_FUE5MainStreamObjectVersion) ?? 0;

  r.group("Native Tail", () => {
    readObjectGuid(r);

    const textureStripFlags = readStripDataFlags(r, "Strip Data Flags (UTexture)");
    if (!isEditorDataStripped(textureStripFlags)) {
      if (mainStreamVer >= MSV_TextureSourceVirtualization) {
        readEditorBulkDataRef(r, "Source Bulk Data");
      } else {
        // Older FByteBulkData path (pre-UE5 assets); leave 6B for UTexture2D tail
        const remaining = endOffset - r.pos - 6;
        if (remaining > 0) r.readBytes(remaining, "Source Bulk Data (FByteBulkData, opaque)");
      }
    }

    readStripDataFlags(r, "Strip Data Flags (UTexture2D)");
    const bCooked = readBool32(r, "bCooked");
    if (bCooked) {
      readBool32(r, "bSerializeMipData");
      const remaining = endOffset - r.pos;
      if (remaining > 0) r.readBytes(remaining, "Cooked Platform Data (opaque)");
    }
  });
}

// ── Registration ──────────────────────────────────────────────────────────────

// All these texture classes share the same serialize chain
const parseTexture2DExport = (r: BinaryReader, _cls: string, offset: number, size: number,
  names: string[], _ue4: number, ue5: number, scriptStart: number, scriptEnd: number,
  cv: ReadonlyMap<string, number>): void => {
  parseExport(r, offset, size, names, ue5, scriptStart, scriptEnd,
    (end) => parseTexture2DTail(r, end, cv));
};

registerParser("Texture2D",             parseTexture2DExport);
registerParser("TextureCube",           parseTexture2DExport);
registerParser("Texture2DArray",        parseTexture2DExport);
registerParser("VolumeTexture",         parseTexture2DExport);
registerParser("TextureRenderTarget2D", parseTexture2DExport);
registerParser("TextureLightProfile",   parseTexture2DExport);
