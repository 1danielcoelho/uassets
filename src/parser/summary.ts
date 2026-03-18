/**
 * FPackageFileSummary parser — the fixed UAsset file header.
 *
 * References:
 *   UE source: Engine/Source/Runtime/CoreUObject/Private/UObject/PackageFileSummary.cpp
 *              Engine/Source/Runtime/CoreUObject/Public/UObject/ObjectVersion.h
 *
 * Parses the fixed header fields at the start of the file and returns all
 * counts/offsets needed by the caller to parse the index tables and export data.
 */

import { BinaryReader } from "./reader.ts";
import { fGuidToString, fEngineVersionToString, customVersionName } from "./utils.ts";
import { flagsStr, EPackageFlags } from "./enums.ts";

// ── EUnrealEngineObjectUE5Version (from ObjectVersion.h, sequential from 1000) ─

export const UE5_NAMES_REFERENCED_FROM_EXPORT_DATA = 1001;
export const UE5_PAYLOAD_TOC                       = 1002;
export const UE5_OPTIONAL_RESOURCES                = 1003;
export const UE5_REMOVE_OBJECT_EXPORT_PACKAGE_GUID = 1005;
export const UE5_TRACK_OBJECT_EXPORT_IS_INHERITED  = 1006;
export const UE5_ADD_SOFTOBJECTPATH_LIST           = 1008;
export const UE5_DATA_RESOURCES                    = 1009;
export const UE5_SCRIPT_SERIALIZATION_OFFSET       = 1010;
export const UE5_METADATA_SERIALIZATION_OFFSET     = 1014;
export const UE5_VERSE_CELLS                       = 1015;
export const UE5_PACKAGE_SAVED_HASH                = 1016;
export const UE5_IMPORT_TYPE_HIERARCHIES           = 1018;

// ── EUnrealEngineObjectUE4Version (counted from VER_UE4_OLDEST_LOADABLE_PACKAGE=214) ─

export const UE4_WORLD_LEVEL_INFO                              = 224;
export const UE4_ADDED_CHUNKID_TO_ASSETDATA_AND_UPACKAGE       = 278;
export const UE4_CHANGED_CHUNKID_TO_BE_AN_ARRAY_OF_CHUNKIDS    = 326;
export const UE4_ENGINE_VERSION_OBJECT                         = 336;
export const UE4_LOAD_FOR_EDITOR_GAME                          = 365;
export const UE4_ADD_STRING_ASSET_REFERENCES_MAP               = 384;
export const UE4_COOKED_ASSETS_IN_EDITOR_SUPPORT               = 485;
export const UE4_PACKAGE_SUMMARY_HAS_COMPATIBLE_ENGINE_VERSION = 444;
export const UE4_SERIALIZE_TEXT_IN_PACKAGES                    = 459;
export const UE4_PRELOAD_DEPENDENCIES_IN_COOKED_EXPORTS        = 507;
export const UE4_TEMPLATEINDEX_IN_COOKED_EXPORTS               = 508;
export const UE4_ADDED_SEARCHABLE_NAMES                        = 510;
export const UE4_64BIT_EXPORTMAP_SERIALSIZES                   = 511;
export const UE4_ADDED_PACKAGE_SUMMARY_LOCALIZATION_ID         = 516;
export const UE4_ADDED_PACKAGE_OWNER                           = 518;
export const UE4_NON_OUTER_PACKAGE_IMPORT                      = 520;
export const UE4_ASSETREGISTRY_DEPENDENCYFLAGS                 = 519;

export const PKG_FILTER_EDITOR_ONLY = 0x80000000;

// ── UE Magic ──────────────────────────────────────────────────────────────────

const PACKAGE_FILE_TAG = 0x9E2A83C1;

// ── Result type ───────────────────────────────────────────────────────────────

/** All fields parsed from the FPackageFileSummary fixed header. */
export interface PackageFileSummaryData {
  legacyFileVersion: number;
  fileVersionUE4: number;
  fileVersionUE5: number;
  packageName: string;
  packageFlags: number;
  customVersions: { name: string; version: number }[];
  savedEngineVersionStr: string;
  nameCount: number;
  nameOffset: number;
  softObjectPathsCount: number;
  softObjectPathsOffset: number;
  gatherableTextDataCount: number;
  gatherableTextDataOffset: number;
  exportCount: number;
  exportOffset: number;
  importCount: number;
  importOffset: number;
  cellExportCount: number;
  cellExportOffset: number;
  cellImportCount: number;
  cellImportOffset: number;
  metadataOffset: number;
  dependsOffset: number;
  softPackageRefsCount: number;
  softPackageRefsOffset: number;
  searchableNamesOffset: number;
  thumbnailTableOffset: number;
  importTypeHierarchiesCount: number;
  importTypeHierarchiesOffset: number;
  assetRegistryDataOffset: number;
  bulkDataStartOffset: number;
  worldTileInfoOffset: number;
  preloadDepCount: number;
  preloadDepOffset: number;
  payloadTocOffset: number;
  dataResourceOffset: number;
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parse the FPackageFileSummary fixed header fields.
 *
 * Reads the magic number, versions, counts, offsets, and other header metadata.
 * Leaves the reader positioned immediately after the header.
 * Throws if the magic number does not match.
 */
export function parsePackageFileSummary(r: BinaryReader): PackageFileSummaryData {
  const magic = r.readUint32("Magic Number");
  if (magic !== PACKAGE_FILE_TAG) {
    throw new Error(`Not a UAsset file: magic 0x${magic.toString(16).toUpperCase()} ≠ 0x9E2A83C1`);
  }

  const legacyFileVersion = r.readInt32("Legacy File Version");

  if (legacyFileVersion !== -4) {
    r.readInt32("Legacy UE3 Version");
  }

  const fileVersionUE4 = r.readInt32("File Version UE4");

  let fileVersionUE5 = 0;
  if (legacyFileVersion <= -8) {
    fileVersionUE5 = r.readInt32("File Version UE5");
  }

  r.readUint32("File Version Licensee");

  // SavedHash (FIoHash = 20 bytes) + TotalHeaderSize come BEFORE custom versions
  // when fileVersionUE5 >= PACKAGE_SAVED_HASH (1016).
  if (fileVersionUE5 >= UE5_PACKAGE_SAVED_HASH) {
    r.readBytes(20, "Saved Hash (FIoHash)");
    r.readInt32("Total Header Size");
  }

  // Custom versions — present when legacyFileVersion <= -2.
  // Format is "Optimized" when legacyFileVersion < -5 (our files have -9).
  // Wire format: TArray where each entry is FGuid (16 bytes) + int32 version = 20 bytes.
  let customVersions: { name: string; version: number }[] = [];
  if (legacyFileVersion <= -2) {
    customVersions = r.group("Custom Versions", () => {
      const count = r.readInt32();
      const result: { name: string; version: number }[] = [];
      for (let i = 0; i < count; i++) {
        let cvGuid!: ReturnType<typeof r.readFGuid>;
        let cvVer!: number;
        r.group(`Custom Version [${i}]`, () => {
          cvGuid = r.readFGuid("GUID");
          cvVer  = r.readInt32("Version");
          const label = customVersionName(cvGuid);
          return `${label} v${cvVer}`;
        });
        result.push({ name: fGuidToString(cvGuid), version: cvVer });
      }
      return result;
    });
  }

  // TotalHeaderSize comes AFTER custom versions when fileVersionUE5 < PACKAGE_SAVED_HASH.
  if (fileVersionUE5 < UE5_PACKAGE_SAVED_HASH) {
    r.readInt32("Total Header Size");
  }

  const packageName  = r.readFString("Package Name");
  const packageFlags = r.readUint32("Package Flags");
  r.setLastDisplay(flagsStr(packageFlags, EPackageFlags));

  const nameCount  = r.readInt32("Name Count");
  const nameOffset = r.readInt32("Name Offset");

  // SoftObjectPaths — UE5 >= ADD_SOFTOBJECTPATH_LIST (1008)
  let softObjectPathsCount = 0, softObjectPathsOffset = 0;
  if (fileVersionUE5 >= UE5_ADD_SOFTOBJECTPATH_LIST) {
    softObjectPathsCount  = r.readInt32("Soft Object Paths Count");
    softObjectPathsOffset = r.readInt32("Soft Object Paths Offset");
  }

  // LocalizationId — editor-only, present when fileVersionUE4 >= 516
  if (fileVersionUE4 >= UE4_ADDED_PACKAGE_SUMMARY_LOCALIZATION_ID) {
    r.readFString("Localization ID");
  }

  // Gatherable text data — UE4 >= 459
  let gatherableTextDataCount = 0, gatherableTextDataOffset = 0;
  if (fileVersionUE4 >= UE4_SERIALIZE_TEXT_IN_PACKAGES) {
    gatherableTextDataCount  = r.readInt32("Gatherable Text Data Count");
    gatherableTextDataOffset = r.readInt32("Gatherable Text Data Offset");
  }

  const exportCount  = r.readInt32("Export Count");
  const exportOffset = r.readInt32("Export Offset");
  const importCount  = r.readInt32("Import Count");
  const importOffset = r.readInt32("Import Offset");

  // Verse cells (virtual machine export/import cells) — UE5 >= 1015
  let cellExportCount = 0, cellExportOffset = 0, cellImportCount = 0, cellImportOffset = 0;
  if (fileVersionUE5 >= UE5_VERSE_CELLS) {
    cellExportCount  = r.readInt32("Cell Export Count");
    cellExportOffset = r.readInt32("Cell Export Offset");
    cellImportCount  = r.readInt32("Cell Import Count");
    cellImportOffset = r.readInt32("Cell Import Offset");
  }

  // Metadata serialization offset — UE5 >= 1014
  let metadataOffset = 0;
  if (fileVersionUE5 >= UE5_METADATA_SERIALIZATION_OFFSET) {
    metadataOffset = r.readInt32("MetaData Offset");
  }

  const dependsOffset = r.readInt32("Depends Offset");

  // Soft package references — UE4 >= 384
  let softPackageRefsCount = 0, softPackageRefsOffset = 0;
  if (fileVersionUE4 >= UE4_ADD_STRING_ASSET_REFERENCES_MAP) {
    softPackageRefsCount  = r.readInt32("Soft Package References Count");
    softPackageRefsOffset = r.readInt32("Soft Package References Offset");
  }

  // Searchable names offset — UE4 >= 510
  let searchableNamesOffset = 0;
  if (fileVersionUE4 >= UE4_ADDED_SEARCHABLE_NAMES) {
    searchableNamesOffset = r.readInt32("Searchable Names Offset");
  }

  const thumbnailTableOffset = r.readInt32("Thumbnail Table Offset");

  // Import type hierarchies (new in UE5 1018)
  let importTypeHierarchiesCount = 0, importTypeHierarchiesOffset = 0;
  if (fileVersionUE5 >= UE5_IMPORT_TYPE_HIERARCHIES) {
    importTypeHierarchiesCount  = r.readInt32("Import Type Hierarchies Count");
    importTypeHierarchiesOffset = r.readInt32("Import Type Hierarchies Offset");
  }

  // Legacy Guid — only present when fileVersionUE5 < PACKAGE_SAVED_HASH (1016)
  if (fileVersionUE5 < UE5_PACKAGE_SAVED_HASH) {
    r.readFGuid("GUID (Legacy)");
  }

  // PersistentGuid — editor-only, present when fileVersionUE4 >= 518.
  // OwnerPersistentGuid was added at 518 and removed at 520 (NON_OUTER_PACKAGE_IMPORT).
  if (fileVersionUE4 >= UE4_ADDED_PACKAGE_OWNER) {
    r.readFGuid("Persistent GUID");
    if (fileVersionUE4 < UE4_NON_OUTER_PACKAGE_IMPORT) {
      r.readFGuid("Owner Persistent GUID");
    }
  }

  // Generations — TArray<FGenerationInfo>, each 8 bytes (exportCount + nameCount)
  r.group("Generations", () => {
    const count = r.readInt32("Count");
    for (let i = 0; i < count; i++) {
      r.group(`Generation[${i}]`, () => {
        const exportCount = r.readInt32("Export Count");
        const nameCount   = r.readInt32("Name Count");
        return `exports=${exportCount} names=${nameCount}`;
      });
    }
  });

  // Saved-by engine version
  let savedEngineVersionStr = "";
  r.group("Saved By Engine Version", () => {
    const v = r.readFEngineVersion();
    savedEngineVersionStr = fEngineVersionToString(v);
    return savedEngineVersionStr;
  });

  // Compatible-with engine version — UE4 >= 444
  if (fileVersionUE4 >= UE4_PACKAGE_SUMMARY_HAS_COMPATIBLE_ENGINE_VERSION) {
    r.group("Compatible With Engine Version", () => {
      const v = r.readFEngineVersion();
      return fEngineVersionToString(v);
    });
  }

  // Compression flags (should be 0 in modern assets)
  r.readUint32("Compression Flags");

  // Compressed chunks (should be empty in modern assets)
  r.group("Compressed Chunks", () =>
    r.readArray(rr => ({
      uncompressedOffset: rr.readInt32(),
      uncompressedSize:   rr.readInt32(),
      compressedOffset:   rr.readInt32(),
      compressedSize:     rr.readInt32(),
    })));

  r.readUint32("Package Source");

  // Additional packages to cook (legacy field, now always empty)
  r.group("Additional Packages To Cook", () =>
    r.readArray(rr => rr.readFString()));

  // NumTextureAllocations (removed in legacyFileVersion -7, but present in -6 and older)
  if (legacyFileVersion > -7) {
    r.readInt32("Num Texture Allocations");
  }

  const assetRegistryDataOffset = r.readInt32("Asset Registry Data Offset");
  const bulkDataStartOffset = Number(r.readInt64("Bulk Data Start Offset"));

  // World tile info offset — UE4 >= 224
  let worldTileInfoOffset = 0;
  if (fileVersionUE4 >= UE4_WORLD_LEVEL_INFO) {
    worldTileInfoOffset = r.readInt32("World Tile Info Data Offset");
  }

  // Chunk IDs — UE4 >= 326 uses TArray<int32>, UE4 >= 278 uses single int32
  if (fileVersionUE4 >= UE4_CHANGED_CHUNKID_TO_BE_AN_ARRAY_OF_CHUNKIDS) {
    r.group("Chunk IDs", () =>
      r.readArray(rr => rr.readInt32()));
  } else if (fileVersionUE4 >= UE4_ADDED_CHUNKID_TO_ASSETDATA_AND_UPACKAGE) {
    r.readInt32("Chunk ID");
  }

  // Preload dependency count + offset — UE4 >= 507
  let preloadDepCount = 0, preloadDepOffset = 0;
  if (fileVersionUE4 >= UE4_PRELOAD_DEPENDENCIES_IN_COOKED_EXPORTS) {
    preloadDepCount  = r.readInt32("Preload Dependency Count");
    preloadDepOffset = r.readInt32("Preload Dependency Offset");
  }

  // NamesReferencedFromExportDataCount — UE5 >= 1001
  if (fileVersionUE5 >= UE5_NAMES_REFERENCED_FROM_EXPORT_DATA) {
    r.readInt32("Names Referenced From Export Data Count");
  }

  // PayloadTocOffset — UE5 >= 1002
  let payloadTocOffset = -1;
  if (fileVersionUE5 >= UE5_PAYLOAD_TOC) {
    payloadTocOffset = Number(r.readInt64("Payload TOC Offset"));
  }

  // DataResourceOffset — UE5 >= 1009
  let dataResourceOffset = 0;
  if (fileVersionUE5 >= UE5_DATA_RESOURCES) {
    dataResourceOffset = r.readInt32("Data Resource Offset");
  }

  return {
    legacyFileVersion,
    fileVersionUE4,
    fileVersionUE5,
    packageName,
    packageFlags,
    customVersions,
    savedEngineVersionStr,
    nameCount,
    nameOffset,
    softObjectPathsCount,
    softObjectPathsOffset,
    gatherableTextDataCount,
    gatherableTextDataOffset,
    exportCount,
    exportOffset,
    importCount,
    importOffset,
    cellExportCount,
    cellExportOffset,
    cellImportCount,
    cellImportOffset,
    metadataOffset,
    dependsOffset,
    softPackageRefsCount,
    softPackageRefsOffset,
    searchableNamesOffset,
    thumbnailTableOffset,
    importTypeHierarchiesCount,
    importTypeHierarchiesOffset,
    assetRegistryDataOffset,
    bulkDataStartOffset,
    worldTileInfoOffset,
    preloadDepCount,
    preloadDepOffset,
    payloadTocOffset,
    dataResourceOffset,
  };
}
