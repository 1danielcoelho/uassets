/**
 * Enum and flags mappings for Unreal Engine binary values.
 *
 * Provides human-readable display strings for numeric enum and bitmask values
 * found in UAsset/UMap files.
 *
 * Usage:
 *   r.readUint32("Package Flags");
 *   r.setLastDisplay(flagsStr(packageFlags, EPackageFlags));
 *
 *   r.readUint8("Method");
 *   r.setLastDisplay(enumStr(method, ECompressedBufferMethod));
 */

// ─── Generic helpers ──────────────────────────────────────────────────────────

/**
 * Build a display string for a simple enum value.
 * Returns e.g. "3 (EMethod::Oodle)" or "7 (unknown)" if not found.
 */
export function enumStr(value: number, map: Record<number, string>): string {
  const name = map[value];
  return name !== undefined ? `${value} (${name})` : `${value} (unknown)`;
}

/**
 * Build a display string for a flags bitmask.
 * Decomposes the value into the named bits from `map` (power-of-two keys).
 * Returns e.g. "0x00000003 (RF_Public | RF_Standalone)" or "0x00000000 (none)".
 *
 * Unknown bits are shown as hex: "0x00040000 (RF_DefaultSubObject | 0x00040000)".
 */
export function flagsStr(value: number, map: Record<number, string>): string {
  const hex = `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
  if (value === 0) return `${hex} (none)`;

  const names: string[] = [];
  let remaining = value >>> 0;
  // Iterate named flags from lowest bit to highest
  for (const [k, name] of Object.entries(map).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const bit = Number(k) >>> 0;
    if (bit === 0) continue;
    if ((remaining & bit) === bit) {
      names.push(name);
      remaining = (remaining & ~bit) >>> 0;
    }
  }
  if (remaining !== 0) {
    names.push(`0x${remaining.toString(16).toUpperCase().padStart(8, "0")}`);
  }
  return `${hex} (${names.join(" | ")})`;
}

/**
 * Like flagsStr but for uint8 values (shows 2-digit hex).
 */
export function flagsStr8(value: number, map: Record<number, string>): string {
  const hex = `0x${(value & 0xFF).toString(16).toUpperCase().padStart(2, "0")}`;
  if (value === 0) return `${hex} (none)`;

  const names: string[] = [];
  let remaining = value & 0xFF;
  for (const [k, name] of Object.entries(map).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const bit = Number(k) & 0xFF;
    if (bit === 0) continue;
    if ((remaining & bit) === bit) {
      names.push(name);
      remaining = (remaining & ~bit) & 0xFF;
    }
  }
  if (remaining !== 0) {
    names.push(`0x${remaining.toString(16).toUpperCase().padStart(2, "0")}`);
  }
  return `${hex} (${names.join(" | ")})`;
}

// ─── EPackageFlags ────────────────────────────────────────────────────────────
// Source: Engine/Source/Runtime/CoreUObject/Public/UObject/ObjectMacros.h

export const EPackageFlags: Record<number, string> = {
  0x00000001: "PKG_NewlyCreated",
  0x00000002: "PKG_ClientOptional",
  0x00000004: "PKG_ServerSideOnly",
  0x00000010: "PKG_CompiledIn",
  0x00000020: "PKG_ForDiffing",
  0x00000040: "PKG_EditorOnly",
  0x00000080: "PKG_Developer",
  0x00000100: "PKG_UncookedOnly",
  0x00000200: "PKG_Cooked",
  0x00000400: "PKG_ContainsNoAsset",
  0x00000800: "PKG_NotExternallyReferenceable",
  0x00001000: "PKG_AccessSpecifierEpicInternal",
  0x00002000: "PKG_UnversionedProperties",
  0x00004000: "PKG_ContainsMapData",
  0x00008000: "PKG_IsSaving",
  0x00010000: "PKG_Compiling",
  0x00020000: "PKG_ContainsMap",
  0x00040000: "PKG_RequiresLocalizationGather",
  0x00080000: "PKG_LoadUncooked",
  0x00100000: "PKG_PlayInEditor",
  0x00200000: "PKG_ContainsScript",
  0x00400000: "PKG_DisallowExport",
  0x08000000: "PKG_CookGenerated",
  0x10000000: "PKG_DynamicImports",
  0x20000000: "PKG_RuntimeGenerated",
  0x40000000: "PKG_ReloadingForCooker",
  0x80000000: "PKG_FilterEditorOnly",
};

// ─── EObjectFlags ─────────────────────────────────────────────────────────────
// Source: Engine/Source/Runtime/CoreUObject/Public/UObject/ObjectMacros.h

export const EObjectFlags: Record<number, string> = {
  0x00000001: "RF_Public",
  0x00000002: "RF_Standalone",
  0x00000004: "RF_MarkAsNative",
  0x00000008: "RF_Transactional",
  0x00000010: "RF_ClassDefaultObject",
  0x00000020: "RF_ArchetypeObject",
  0x00000040: "RF_Transient",
  0x00000080: "RF_MarkAsRootSet",
  0x00000100: "RF_TagGarbageTemp",
  0x00000200: "RF_NeedInitialization",
  0x00000400: "RF_NeedLoad",
  0x00000800: "RF_KeepForCooker",
  0x00001000: "RF_NeedPostLoad",
  0x00002000: "RF_NeedPostLoadSubobjects",
  0x00004000: "RF_NewerVersionExists",
  0x00008000: "RF_BeginDestroyed",
  0x00010000: "RF_FinishDestroyed",
  0x00020000: "RF_BeingRegenerated",
  0x00040000: "RF_DefaultSubObject",
  0x00080000: "RF_WasLoaded",
  0x00100000: "RF_TextExportTransient",
  0x00200000: "RF_LoadCompleted",
  0x00400000: "RF_InheritableComponentTemplate",
  0x00800000: "RF_DuplicateTransient",
  0x01000000: "RF_StrongRefOnFrame",
  0x02000000: "RF_NonPIEDuplicateTransient",
  0x04000000: "RF_ImmutableDefaultObject",
  0x08000000: "RF_WillBeLoaded",
  0x10000000: "RF_HasExternalPackage",
  0x20000000: "RF_MigratingAsset",
  0x40000000: "RF_MirroredGarbage",
  0x80000000: "RF_AllocatedInSharedPage",
};

// ─── EPropertyTagFlags ────────────────────────────────────────────────────────
// Source: Engine/Source/Runtime/CoreUObject/Public/UObject/PropertyTag.h

export const EPropertyTagFlags: Record<number, string> = {
  0x01: "HasArrayIndex",
  0x02: "HasPropertyGuid",
  0x04: "HasPropertyExtensions",
  0x08: "HasBinaryOrNativeSerialize",
  0x10: "BoolTrue",
  0x20: "SkippedSerialize",
};

// ─── EPropertyTagExtension ────────────────────────────────────────────────────

export const EPropertyTagExtension: Record<number, string> = {
  0x02: "OverridableInformation",
};

// ─── EClassSerializationControlExtension ──────────────────────────────────────

export const EClassSerializationControlExtension: Record<number, string> = {
  0x02: "OverridableSerializationInfo",
};

// ─── ECompressedBufferMethod ──────────────────────────────────────────────────
// Source: Engine/Source/Runtime/Core/Private/Compression/CompressedBuffer.cpp

export const ECompressedBufferMethod: Record<number, string> = {
  0: "EMethod::None",
  1: "EMethod::Kraken",
  2: "EMethod::Leviathan",
  3: "EMethod::Oodle",
  4: "EMethod::LZ4",
};

// ─── EEditorBulkDataFlags (FEditorBulkData::EFlags) ───────────────────────────
// Source: Engine/Source/Runtime/CoreUObject/Public/Serialization/EditorBulkData.h

export const EEditorBulkDataFlags: Record<number, string> = {
  0x001: "IsVirtualized",
  0x002: "HasPayloadSidecarFile",
  0x004: "ReferencesLegacyFile",
  0x008: "LegacyFileIsCompressed",
  0x010: "DisablePayloadCompression",
  0x020: "LegacyKeyWasGuidDerived",
  0x040: "HasRegistered",
  0x080: "IsTornOff",
  0x100: "ReferencesWorkspaceDomain",
  0x200: "StoredInPackageTrailer",
  0x400: "IsCooked",
  0x800: "WasDetached",
};

// ─── FStripDataFlags (global strip flags byte) ────────────────────────────────
// Source: Engine/Source/Runtime/CoreUObject/Public/UObject/ObjectMacros.h
// Only the first byte (globalFlags) has standard named bits.

export const EStripDataGlobalFlags: Record<number, string> = {
  0x01: "EditorDataStripped",
  0x02: "AVDataStripped",
};
