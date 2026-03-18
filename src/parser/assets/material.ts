/**
 * UMaterial and UMaterialInstance export parsers.
 *
 * Relevant UE source:
 *   Engine/Source/Runtime/Engine/Private/Materials/Material.cpp
 *     UMaterial::Serialize (~line 3054)
 *   Engine/Source/Runtime/Engine/Private/Materials/MaterialInterface.cpp
 *     UMaterialInterface::Serialize (~line 206)
 *   Engine/Source/Runtime/Engine/Private/Materials/MaterialInstance.cpp
 *     UMaterialInstance::Serialize (~line 3197)
 *
 * Serialization call chain for UMaterial:
 *   UObject::Serialize          → tagged properties + PossiblySerializeObjectGuid
 *   UMaterialInterface::Serialize → bSavedCachedExpressionData (bool32) [if UE5R >= 14]
 *   UMaterial::Serialize        → SerializeInlineShaderMaps (int32 count + data)
 *                                 + bForceNaniteUsage (bool32) [if RV >= 47]
 *
 * Serialization call chain for UMaterialInstance:
 *   UObject::Serialize          → tagged properties + PossiblySerializeObjectGuid
 *   UMaterialInterface::Serialize → bSavedCachedExpressionData (bool32) [if UE5R >= 14]
 *   UMaterialInstance::Serialize → bSavedCachedData (bool32) [if MSV >= 36]
 *                                  + optional CachedData tagged props
 *                                  + optional SerializeInlineShaderMaps [if bHasStaticPermutation]
 */

import type { BinaryReader } from "../reader.ts";
import { registerParser } from "../dispatch.ts";
import {
  GUID_FRenderingObjectVersion,
  GUID_FUE5ReleaseStreamObjectVersion,
  GUID_FUE5MainStreamObjectVersion,
  readBool32, readObjectGuid, parseExport,
} from "../utils.ts";

// ── Version constants ─────────────────────────────────────────────────────────

// Source: EUnrealEngineObjectUE4Version::VER_UE4_PURGED_FMATERIAL_COMPILE_OUTPUTS
const VER_UE4_PURGED_FMATERIAL_COMPILE_OUTPUTS = 260;
// FUE5ReleaseStreamObjectVersion::MaterialInterfaceSavedCachedData
const UE5R_MaterialInterfaceSavedCachedData = 14;
// FUE5MainStreamObjectVersion::MaterialSavedCachedData
const MSV_MaterialSavedCachedData = 36;
// FRenderingObjectVersion::NaniteForceMaterialUsage
const RV_NaniteForceMaterialUsage = 47;

// ── Inline shader maps ────────────────────────────────────────────────────────

/** SerializeInlineShaderMaps: int32 NumResourcesToSave + shader blobs (cooked only; 0 in editor saves). */
function readInlineShaderMaps(r: BinaryReader, endOffset: number): void {
  r.group("Inline Shader Maps", () => {
    const numResources = r.readInt32("NumResources");
    if (numResources > 0 && r.pos < endOffset) {
      r.readBytes(endOffset - r.pos, "Shader Map Data (opaque)");
    }
  });
}

// ── Export tails ──────────────────────────────────────────────────────────────

/**
 * UMaterial tail.
 * Non-cooked editor layout (16 bytes for M_CustomMaterial.uasset):
 *   0- 3: PossiblySerializeObjectGuid (bool32=0)
 *   4- 7: bSavedCachedExpressionData  [if UE5R >= 14]
 *   8-11: NumResources=0              [if UE4 >= 260]
 *  12-15: bForceNaniteUsage           [if RV >= 47]
 */
function parseMaterialTail(
  r: BinaryReader,
  endOffset: number,
  fileVersionUE4: number,
  customVersions: ReadonlyMap<string, number>,
): void {
  const ue5ReleaseVer = customVersions.get(GUID_FUE5ReleaseStreamObjectVersion) ?? 0;
  const renderingVer  = customVersions.get(GUID_FRenderingObjectVersion)         ?? 0;

  r.group("Native Tail", () => {
    readObjectGuid(r);

    if (ue5ReleaseVer >= UE5R_MaterialInterfaceSavedCachedData) {
      readBool32(r, "bSavedCachedExpressionData");
    }

    if (fileVersionUE4 >= VER_UE4_PURGED_FMATERIAL_COMPILE_OUTPUTS) {
      // Reserve room for bForceNaniteUsage (4B) if it will follow
      const shaderMapsEnd = renderingVer >= RV_NaniteForceMaterialUsage ? endOffset - 4 : endOffset;
      readInlineShaderMaps(r, shaderMapsEnd);
    }

    if (renderingVer >= RV_NaniteForceMaterialUsage) {
      readBool32(r, "bForceNaniteUsage");
    }
  });
}

/**
 * UMaterialInstance tail.
 * Non-cooked editor layout (12 bytes for MI_TextureMaterial.uasset):
 *   0- 3: PossiblySerializeObjectGuid (bool32=0)
 *   4- 7: bSavedCachedExpressionData  [if UE5R >= 14]
 *   8-11: bSavedCachedData            [if MSV >= 36]
 */
function parseMaterialInstanceTail(
  r: BinaryReader,
  endOffset: number,
  fileVersionUE4: number,
  customVersions: ReadonlyMap<string, number>,
): void {
  const ue5ReleaseVer = customVersions.get(GUID_FUE5ReleaseStreamObjectVersion) ?? 0;
  const mainStreamVer = customVersions.get(GUID_FUE5MainStreamObjectVersion)    ?? 0;

  r.group("Native Tail", () => {
    readObjectGuid(r);

    if (ue5ReleaseVer >= UE5R_MaterialInterfaceSavedCachedData) {
      readBool32(r, "bSavedCachedExpressionData");
    }

    if (mainStreamVer >= MSV_MaterialSavedCachedData) {
      const bSavedCachedData = readBool32(r, "bSavedCachedData");
      if (bSavedCachedData) {
        r.group("CachedData", () => {
          r.readBytes(endOffset - r.pos, "CachedData (opaque)");
        });
        return;
      }
    }

    if (fileVersionUE4 >= VER_UE4_PURGED_FMATERIAL_COMPILE_OUTPUTS && r.pos < endOffset) {
      readInlineShaderMaps(r, endOffset);
    }
  });
}

// ── Registration ──────────────────────────────────────────────────────────────

registerParser("Material", (r, _cls, offset, size, names, ue4, ue5, scriptStart, scriptEnd, cv) => {
  parseExport(r, offset, size, names, ue5, scriptStart, scriptEnd,
    (end) => parseMaterialTail(r, end, ue4, cv));
});

registerParser("MaterialInstanceConstant", (r, _cls, offset, size, names, ue4, ue5, scriptStart, scriptEnd, cv) => {
  parseExport(r, offset, size, names, ue5, scriptStart, scriptEnd,
    (end) => parseMaterialInstanceTail(r, end, ue4, cv));
});

registerParser("MaterialInstanceDynamic", (r, _cls, offset, size, names, ue4, ue5, scriptStart, scriptEnd, cv) => {
  parseExport(r, offset, size, names, ue5, scriptStart, scriptEnd,
    (end) => parseMaterialInstanceTail(r, end, ue4, cv));
});
