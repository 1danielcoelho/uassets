/**
 * UMaterial and UMaterialInstance export parsers.
 *
 * Handles parsing the native (non-tagged-property) portions of Material
 * and MaterialInstance exports: the Export Tail that follows the tagged-
 * property block.
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
import { parseTaggedProperties } from "../tagged-properties.ts";

// ── Version GUIDs ─────────────────────────────────────────────────────────────
const GUID_FRenderingObjectVersion        = "12F88B9F-88754AFC-A67CD90C-383ABD29";
const GUID_FUE5MainStreamObjectVersion    = "697DD581-E64F41AB-AA4A51EC-BEB7B628";
const GUID_FUE5ReleaseStreamObjectVersion = "D89B5E42-24BD4D46-8412ACA8-DF641779";

// ── Version constants ─────────────────────────────────────────────────────────

// UE4 file version at which FMaterial compile outputs were purged (= 260)
// Source: EUnrealEngineObjectUE4Version::VER_UE4_PURGED_FMATERIAL_COMPILE_OUTPUTS
const VER_UE4_PURGED_FMATERIAL_COMPILE_OUTPUTS = 260;

// FUE5ReleaseStreamObjectVersion::MaterialInterfaceSavedCachedData = 14
// When >= this version, UMaterialInterface writes bSavedCachedExpressionData (bool32)
const UE5R_MaterialInterfaceSavedCachedData = 14;

// FUE5MainStreamObjectVersion::MaterialSavedCachedData = 36
// When >= this version, UMaterialInstance writes bSavedCachedData (bool32)
const MSV_MaterialSavedCachedData = 36;

// FRenderingObjectVersion::NaniteForceMaterialUsage = 47
// When >= this version, UMaterial writes bForceNaniteUsage (bool32)
const RV_NaniteForceMaterialUsage = 47;

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

// ── Inline shader maps ────────────────────────────────────────────────────────

/**
 * SerializeInlineShaderMaps: writes int32 NumResourcesToSave + data per resource.
 * For editor (non-cooked) saves: NumResourcesToSave = 0, nothing else.
 * For cooked saves: NumResourcesToSave > 0 + shader map blobs.
 */
function readInlineShaderMaps(r: BinaryReader, endOffset: number): void {
  r.group("Inline Shader Maps", () => {
    const numResources = r.readInt32("NumResources");
    if (numResources > 0 && r.pos < endOffset) {
      // Shader map data is complex; read as opaque remainder
      r.readBytes(endOffset - r.pos, "Shader Map Data (opaque)");
    }
  });
}

// ── UMaterial Export Tail ─────────────────────────────────────────────────────

/**
 * Parse the Export Tail of a UMaterial export.
 *
 * Non-cooked editor layout (16 bytes for M_CustomMaterial.uasset):
 *   pos  0- 3: PossiblySerializeObjectGuid (bool32=0)
 *   pos  4- 7: bSavedCachedExpressionData (bool32, from UMaterialInterface) [if UE5R >= 14]
 *   pos  8-11: NumResources (int32=0, from SerializeInlineShaderMaps) [if UE4Ver >= 260]
 *   pos 12-15: bForceNaniteUsage (bool32, from UMaterial) [if RV >= 47]
 *   Total = 16 bytes
 */
function parseMaterialTail(
  r: BinaryReader,
  endOffset: number,
  fileVersionUE4: number,
  customVersions: ReadonlyMap<string, number>,
): void {
  const ue5ReleaseVer  = customVersions.get(GUID_FUE5ReleaseStreamObjectVersion) ?? 0;
  const renderingVer   = customVersions.get(GUID_FRenderingObjectVersion)         ?? 0;

  r.group("Native Tail", () => {
    // 1. UObject::PossiblySerializeObjectGuid
    r.group("Object GUID (Lazy Ptr)", () => {
      const hasGuid = readBool32(r, "Has GUID");
      if (hasGuid) readFGuid(r, "GUID");
    });

    // 2. UMaterialInterface::Serialize — bSavedCachedExpressionData
    if (ue5ReleaseVer >= UE5R_MaterialInterfaceSavedCachedData) {
      readBool32(r, "bSavedCachedExpressionData");
      // If bSavedCachedExpressionData were true, tagged property data would follow.
      // For non-cooked editor saves it's always false; cooked data not in our test set.
    }

    // 3. UMaterial::Serialize — SerializeInlineShaderMaps
    if (fileVersionUE4 >= VER_UE4_PURGED_FMATERIAL_COMPILE_OUTPUTS) {
      // For cooked assets, shader data precedes bForceNaniteUsage.
      // Reserve 4 bytes for bForceNaniteUsage if it will be written.
      const shaderMapsEnd = renderingVer >= RV_NaniteForceMaterialUsage
        ? endOffset - 4
        : endOffset;
      readInlineShaderMaps(r, shaderMapsEnd);
    }

    // 4. UMaterial::Serialize — bForceNaniteUsage
    if (renderingVer >= RV_NaniteForceMaterialUsage) {
      readBool32(r, "bForceNaniteUsage");
    }
  });
}

// ── UMaterialInstance Export Tail ─────────────────────────────────────────────

/**
 * Parse the Export Tail of a UMaterialInstance/UMaterialInstanceConstant export.
 *
 * Non-cooked editor layout (12 bytes for MI_TextureMaterial.uasset):
 *   pos  0- 3: PossiblySerializeObjectGuid (bool32=0)
 *   pos  4- 7: bSavedCachedExpressionData (bool32, from UMaterialInterface) [if UE5R >= 14]
 *   pos  8-11: bSavedCachedData (bool32, from UMaterialInstance) [if MSV >= 36]
 *   Total = 12 bytes (when bSavedCachedData=false and bHasStaticPermutationResource=false)
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
    // 1. UObject::PossiblySerializeObjectGuid
    r.group("Object GUID (Lazy Ptr)", () => {
      const hasGuid = readBool32(r, "Has GUID");
      if (hasGuid) readFGuid(r, "GUID");
    });

    // 2. UMaterialInterface::Serialize — bSavedCachedExpressionData
    if (ue5ReleaseVer >= UE5R_MaterialInterfaceSavedCachedData) {
      readBool32(r, "bSavedCachedExpressionData");
    }

    // 3. UMaterialInstance::Serialize — bSavedCachedData
    if (mainStreamVer >= MSV_MaterialSavedCachedData) {
      const bSavedCachedData = readBool32(r, "bSavedCachedData");
      if (bSavedCachedData) {
        // FMaterialInstanceCachedData serialized as tagged properties
        r.group("CachedData", () => {
          const remaining = endOffset - r.pos;
          r.readBytes(remaining, "CachedData (opaque)");
        });
        return;
      }
    }

    // 4. If bHasStaticPermutationResource AND UEVer >= 260: SerializeInlineShaderMaps
    // bHasStaticPermutationResource was already loaded from tagged properties.
    // We can detect it by checking if there are remaining bytes.
    if (fileVersionUE4 >= VER_UE4_PURGED_FMATERIAL_COMPILE_OUTPUTS && r.pos < endOffset) {
      readInlineShaderMaps(r, endOffset);
    }
  });
}

// ── Main entry points ─────────────────────────────────────────────────────────

function parseMaterialExport(
  r: BinaryReader,
  _classname: string,
  offset: number,
  size: number,
  names: string[],
  fileVersionUE4: number,
  fileVersionUE5: number,
  scriptStart: number,
  scriptEnd: number,
  customVersions: ReadonlyMap<string, number>,
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
    parseMaterialTail(r, absEnd, fileVersionUE4, customVersions);
  }
}

function parseMaterialInstanceExport(
  r: BinaryReader,
  _classname: string,
  offset: number,
  size: number,
  names: string[],
  fileVersionUE4: number,
  fileVersionUE5: number,
  scriptStart: number,
  scriptEnd: number,
  customVersions: ReadonlyMap<string, number>,
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
    parseMaterialInstanceTail(r, absEnd, fileVersionUE4, customVersions);
  }
}

// Register parsers
registerParser("Material",                 parseMaterialExport);
registerParser("MaterialInstanceConstant", parseMaterialInstanceExport);
registerParser("MaterialInstanceDynamic",  parseMaterialInstanceExport);
