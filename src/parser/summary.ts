/**
 * FPackageFileSummary parser — the main UAsset file header.
 *
 * References:
 *   UE source: Engine/Source/Runtime/CoreUObject/Private/UObject/PackageFileSummary.cpp
 *              Engine/Source/Runtime/CoreUObject/Public/UObject/ObjectVersion.h
 *   Python ref: uassetparser.py (Epic's own Python reference implementation)
 *
 * The header sits at offset 0 and contains all offset tables. We parse it
 * in three phases:
 *   1. Fixed header fields (magic, versions, flags, counts, offsets)
 *   2. Index tables (names, imports, exports) — seeked to by offset
 *   3. Export data — dispatched by class name
 */

import { BinaryReader } from "./reader.ts";
import {
  fGuidToString,
  fEngineVersionToString,
  type FObjectExport,
  type FObjectImport,
} from "./primitives.ts";
import { dispatchExport } from "./dispatch.ts";
import type { ParseResult, AssetSummary } from "../types.ts";

// ── UE Magic ──────────────────────────────────────────────────────────────────

const PACKAGE_FILE_TAG = 0x9E2A83C1;

// ── EUnrealEngineObjectUE5Version (from ObjectVersion.h, sequential from 1000) ─

const UE5_NAMES_REFERENCED_FROM_EXPORT_DATA = 1001;
const UE5_PAYLOAD_TOC                       = 1002;
const UE5_OPTIONAL_RESOURCES                = 1003;
const UE5_REMOVE_OBJECT_EXPORT_PACKAGE_GUID = 1005;
const UE5_TRACK_OBJECT_EXPORT_IS_INHERITED  = 1006;
const UE5_ADD_SOFTOBJECTPATH_LIST           = 1008;
const UE5_DATA_RESOURCES                    = 1009;
const UE5_SCRIPT_SERIALIZATION_OFFSET       = 1010;
const UE5_METADATA_SERIALIZATION_OFFSET     = 1014;
const UE5_VERSE_CELLS                       = 1015;
const UE5_PACKAGE_SAVED_HASH                = 1016;
const UE5_IMPORT_TYPE_HIERARCHIES           = 1018;

// ── EUnrealEngineObjectUE4Version (counted from VER_UE4_OLDEST_LOADABLE_PACKAGE=214) ─
// These values are derived by counting the enum entries in ObjectVersion.h.

const UE4_WORLD_LEVEL_INFO                              = 224;
const UE4_ADDED_CHUNKID_TO_ASSETDATA_AND_UPACKAGE       = 278;
const UE4_CHANGED_CHUNKID_TO_BE_AN_ARRAY_OF_CHUNKIDS    = 326;
const UE4_ENGINE_VERSION_OBJECT                         = 336;
const UE4_LOAD_FOR_EDITOR_GAME                          = 365;
const UE4_ADD_STRING_ASSET_REFERENCES_MAP               = 384;
const UE4_COOKED_ASSETS_IN_EDITOR_SUPPORT               = 485;
const UE4_PACKAGE_SUMMARY_HAS_COMPATIBLE_ENGINE_VERSION = 444;
const UE4_SERIALIZE_TEXT_IN_PACKAGES                    = 459;
const UE4_PRELOAD_DEPENDENCIES_IN_COOKED_EXPORTS        = 507;
const UE4_TEMPLATEINDEX_IN_COOKED_EXPORTS               = 508;
const UE4_ADDED_SEARCHABLE_NAMES                        = 510;
const UE4_64BIT_EXPORTMAP_SERIALSIZES                   = 511;
const UE4_ADDED_PACKAGE_SUMMARY_LOCALIZATION_ID         = 516;
const UE4_ADDED_PACKAGE_OWNER                           = 518;
const UE4_NON_OUTER_PACKAGE_IMPORT                      = 520;
const UE4_ASSETREGISTRY_DEPENDENCYFLAGS                 = 519;

const PKG_FILTER_EDITOR_ONLY = 0x80000000;

// ── Main parser ───────────────────────────────────────────────────────────────

export function parseUAsset(buffer: ArrayBuffer): ParseResult {
  const r = new BinaryReader(buffer);

  // ── Phase 1: Fixed header ────────────────────────────────────────────────

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
        const cv = r.group(`Custom Version [${i}]`, () => {
          const guid = r.readFGuid("GUID");
          const ver  = r.readInt32("Version");
          const guidStr = fGuidToString(guid);
          return { guid, version: ver, label: `${guidStr} v${ver}` };
        });
        result.push({ name: fGuidToString(cv.guid), version: cv.version });
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

  // ── Phase 2: Index tables ─────────────────────────────────────────────────

  // Names table
  const names: string[] = [];
  if (nameCount > 0 && nameOffset > 0) {
    r.seek(nameOffset);
    r.group("Names Table", () => {
      for (let i = 0; i < nameCount; i++) {
        const name = r.group(`Name[${i}]`, () => {
          const s = r.readFString("String");
          // Hash(es) follow each name entry. UE4 >= VER_UE4_NAME_HASHES_SERIALIZED (504):
          // 2 × uint16 = 4 bytes (non-case-preserving + case-preserving hash).
          // All files we support (>= 4.27 = fileVersionUE4 >= ~519) have hashes.
          r.readUint16("Hash (non-preserving)");
          r.readUint16("Hash (preserving)");
          return s;
        });
        names.push(name);
      }
      return names;
    });
  }

  // Imports table.
  // FName in the import/export map is stored as 2 × int32 (index + instance number).
  // For UE5.7 (fileVersionUE4=522, fileVersionUE5=1018):
  //   - PackageName (FName) added: fileVersionUE4 >= 520 (NON_OUTER_PACKAGE_IMPORT), editor-only
  //   - bImportOptional (bool as int32) added: fileVersionUE5 >= 1003 (OPTIONAL_RESOURCES)
  const imports: FObjectImport[] = [];
  if (importCount > 0 && importOffset > 0) {
    r.seek(importOffset);
    r.group("Imports Table", () => {
      for (let i = 0; i < importCount; i++) {
        r.group(`Import[${i}]`, () => {
          const classPackageIdx = r.readInt32();
          /* classPackageNum = */ r.readInt32();
          const classNameIdx    = r.readInt32();
          /* classNameNum = */    r.readInt32();
          const outerIndex      = r.readInt32();
          const objectNameIdx   = r.readInt32();
          /* objectNameNum = */   r.readInt32();

          // Editor-only: PackageName (FName = 2 × int32) since fileVersionUE4 >= 520
          if (fileVersionUE4 >= UE4_NON_OUTER_PACKAGE_IMPORT) {
            r.readInt32(); // packageNameIdx
            r.readInt32(); // packageNameNum
          }

          // bImportOptional (serialized as int32 in binary archive) since fileVersionUE5 >= 1003
          if (fileVersionUE5 >= UE5_OPTIONAL_RESOURCES) {
            r.readInt32();
          }

          const imp: FObjectImport = {
            classPackage: classPackageIdx,
            className:    classNameIdx,
            outerIndex,
            objectName:   objectNameIdx,
          };
          imports.push(imp);
          return imp;
        });
      }
      return imports;
    });
  }

  // Exports table.
  // For UE5.7 (fileVersionUE4=522, fileVersionUE5=1018):
  //   ObjectName is FName (2 × int32)
  //   TemplateIndex present: fileVersionUE4 >= 508 ✓
  //   SerialSize/Offset as int64: fileVersionUE4 >= 511 ✓
  //   PackageGuid+PackageFlags REMOVED: fileVersionUE5 >= 1005 ✓
  //   bNotAlwaysLoadedForEditorGame present: fileVersionUE4 >= 365 ✓
  //   bIsAsset present: fileVersionUE4 >= 485 ✓
  //   bIsInherited present: fileVersionUE5 >= 1006 ✓
  //   ScriptSerializationStart/EndOffset present: fileVersionUE5 >= 1010 ✓
  //   FirstExportDependency etc present: fileVersionUE4 >= 507 ✓
  const exports: FObjectExport[] = [];
  if (exportCount > 0 && exportOffset > 0) {
    r.seek(exportOffset);
    r.group("Exports Table", () => {
      for (let i = 0; i < exportCount; i++) {
        r.group(`Export[${i}]`, () => {
          const classIndex  = r.readInt32();
          const superIndex  = r.readInt32();
          const templateIndex = (fileVersionUE4 >= UE4_TEMPLATEINDEX_IN_COOKED_EXPORTS)
            ? r.readInt32() : 0;
          const outerIndex  = r.readInt32();
          const objectNameIdx = r.readInt32(); // FName index
          /* objectNameNum */ r.readInt32();   // FName instance number (ignore)
          const objectFlags = r.readUint32();

          const serialSize   = (fileVersionUE4 >= UE4_64BIT_EXPORTMAP_SERIALSIZES)
            ? r.readInt64() : BigInt(r.readInt32());
          const serialOffset = (fileVersionUE4 >= UE4_64BIT_EXPORTMAP_SERIALSIZES)
            ? r.readInt64() : BigInt(r.readInt32());

          const forcedExport = r.readInt32() !== 0;
          const notForClient = r.readInt32() !== 0;
          const notForServer = r.readInt32() !== 0;

          // PackageGuid removed in UE5 >= 1005, but PackageFlags is ALWAYS present
          let packageGuid = undefined as any;
          if (fileVersionUE5 < UE5_REMOVE_OBJECT_EXPORT_PACKAGE_GUID) {
            packageGuid = r.readFGuid();
          }

          // bIsInheritedInstance — UE5 >= 1006, serialized BEFORE PackageFlags
          const isInherited =
            (fileVersionUE5 >= UE5_TRACK_OBJECT_EXPORT_IS_INHERITED) ? r.readInt32("Is Inherited Instance") !== 0 : false;

          // PackageFlags — always present (even when PackageGuid was removed)
          const exportPackageFlags = r.readUint32();

          const notAlwaysLoadedForEditorGame =
            (fileVersionUE4 >= UE4_LOAD_FOR_EDITOR_GAME) ? r.readInt32() !== 0 : false;
          const isAsset =
            (fileVersionUE4 >= UE4_COOKED_ASSETS_IN_EDITOR_SUPPORT) ? r.readInt32() !== 0 : false;

          // bGeneratePublicHash — UE5 >= 1003 (OPTIONAL_RESOURCES)
          const generatePublicHash =
            (fileVersionUE5 >= UE5_OPTIONAL_RESOURCES) ? r.readInt32() !== 0 : false;

          // Preload dependency indices — UE4 >= 507
          let firstExportDep = -1;
          let serBeforeSerDeps = 0, createBeforeSerDeps = 0,
              serBeforeCreateDeps = 0, createBeforeCreateDeps = 0;
          if (fileVersionUE4 >= UE4_PRELOAD_DEPENDENCIES_IN_COOKED_EXPORTS) {
            firstExportDep         = r.readInt32();
            serBeforeSerDeps       = r.readInt32();
            createBeforeSerDeps    = r.readInt32();
            serBeforeCreateDeps    = r.readInt32();
            createBeforeCreateDeps = r.readInt32();
          }

          // Script serialization offsets — UE5 >= 1010, serialized AFTER dependency counts
          let scriptSerializationStartOffset = 0n;
          let scriptSerializationEndOffset   = 0n;
          if (fileVersionUE5 >= UE5_SCRIPT_SERIALIZATION_OFFSET) {
            scriptSerializationStartOffset = r.readInt64("Script Serialization Start Offset");
            scriptSerializationEndOffset   = r.readInt64("Script Serialization End Offset");
          }

          const exp: FObjectExport = {
            classIndex, superIndex, templateIndex, outerIndex,
            objectName: objectNameIdx,
            objectFlags, serialSize, serialOffset,
            forcedExport, notForClient, notForServer,
            packageGuid: packageGuid ?? { a: 0, b: 0, c: 0, d: 0 },
            packageFlags: exportPackageFlags,
            notAlwaysLoadedForEditorGame,
            isAsset,
            generatePublicHash,
            firstExportDependency: firstExportDep,
            serializationBeforeSerializationDependencies: serBeforeSerDeps,
            createBeforeSerializationDependencies: createBeforeSerDeps,
            serializationBeforeCreateDependencies: serBeforeCreateDeps,
            createBeforeCreateDependencies: createBeforeCreateDeps,
            isInherited,
            scriptSerializationStartOffset,
            scriptSerializationEndOffset,
          };
          exports.push(exp);
          return exp;
        });
      }
      return exports;
    });
  }

  // ── Phase 2.5: Remaining index tables ────────────────────────────────────

  // Depends Map — one TArray<FPackageIndex> per export.
  // Each entry lists the package indices that must be loaded before this export.
  // FPackageIndex: positive = export (1-based), negative = import (1-based), 0 = none.
  if (dependsOffset > 0 && exportCount > 0) {
    r.seek(dependsOffset);
    r.group("Depends Map", () => {
      for (let i = 0; i < exportCount; i++) {
        r.group(`Depends[${i}]`, () => {
          const count = r.readInt32();
          const deps: number[] = [];
          for (let j = 0; j < count; j++) {
            const idx = r.readInt32(`Dep[${j}]`);
            deps.push(idx);
          }
          return deps.length > 0 ? deps.join(", ") : "(none)";
        });
      }
    });
  }

  // Soft Object Paths — UE5 >= 1008.
  // Each FSoftObjectPath = FTopLevelAssetPath (2 × FName = 4 × int32) + FString subpath.
  // When FSoftObjectPath appears in the package body (metadata, property values, etc.)
  // it is serialized as a single int32 index into this table (see FLinkerLoad).
  const softObjectPaths: string[] = [];
  if (softObjectPathsOffset > 0 && softObjectPathsCount > 0) {
    r.seek(softObjectPathsOffset);
    r.group("Soft Object Paths", () => {
      for (let i = 0; i < softObjectPathsCount; i++) {
        const path = r.group(`SoftObjectPath[${i}]`, () => {
          const pkgIdx   = r.readInt32("Package Name Index");
                           r.readInt32(); // package name number
          const assetIdx = r.readInt32("Asset Name Index");
                           r.readInt32(); // asset name number
          const subPath  = r.readFString("Sub Path");
          const pkg   = resolveName(names, pkgIdx);
          const asset = resolveName(names, assetIdx);
          return subPath ? `${pkg}.${asset}:${subPath}` : `${pkg}.${asset}`;
        });
        softObjectPaths.push(path);
      }
    });
  }

  // Soft Package References — UE4 >= 384.
  // Same FSoftObjectPath wire format as soft object paths above.
  if (softPackageRefsOffset > 0 && softPackageRefsCount > 0) {
    r.seek(softPackageRefsOffset);
    r.group("Soft Package References", () => {
      for (let i = 0; i < softPackageRefsCount; i++) {
        r.group(`SoftRef[${i}]`, () => {
          const pkgIdx   = r.readInt32("Package Name Index");
                           r.readInt32(); // package name number
          const assetIdx = r.readInt32("Asset Name Index");
                           r.readInt32(); // asset name number
          const subPath  = r.readFString("Sub Path");
          const pkg   = resolveName(names, pkgIdx);
          const asset = resolveName(names, assetIdx);
          return subPath ? `${pkg}.${asset}:${subPath}` : `${pkg}.${asset}`;
        });
      }
    });
  }

  // Searchable Names — UE4 >= 510.
  // TMap<FPackageIndex, TArray<FName>> serialised as count-prefixed K/V pairs.
  if (searchableNamesOffset > 0) {
    r.seek(searchableNamesOffset);
    r.group("Searchable Names", () => {
      const entryCount = r.readInt32("Entry Count");
      for (let i = 0; i < entryCount; i++) {
        r.group(`Entry[${i}]`, () => {
          r.readInt32("Package Index");
          const nameCount = r.readInt32("Name Count");
          for (let j = 0; j < nameCount; j++) {
            r.readInt32(`Name[${j}] Index`);
            r.readInt32(); // name number
          }
        });
      }
    });
  }

  // Preload Dependencies — UE4 >= 507.
  // Flat TArray<FPackageIndex>; count comes from the summary header.
  if (preloadDepOffset > 0 && preloadDepCount > 0) {
    r.seek(preloadDepOffset);
    r.group("Preload Dependencies", () => {
      for (let i = 0; i < preloadDepCount; i++) {
        r.readInt32(`Dep[${i}]`);
      }
    });
  }

  // Data Resources — UE5 >= 1009.
  // FObjectDataResource::Serialize: versioned header then per-resource records.
  if (dataResourceOffset > 0) {
    r.seek(dataResourceOffset);
    r.group("Data Resources", () => {
      const drVersion = r.readUint32("Version");
      const drCount   = r.readInt32("Count");
      for (let i = 0; i < drCount; i++) {
        r.group(`DataResource[${i}]`, () => {
          r.readUint32("Flags");
          // AddedCookedIndex = version 2, which is currently Latest
          if (drVersion >= 2) r.readInt32("Cooked Index");
          r.readInt64("Serial Offset");
          r.readInt64("Duplicate Serial Offset");
          r.readInt64("Serial Size");
          r.readInt64("Raw Size");
          r.readInt32("Outer Index");
          r.readUint32("Legacy Bulk Data Flags");
        });
      }
    });
  }

  // Verse Cell Exports — UE5 >= 1015.
  // FCellExport: FName + FString + 3×int64 + 3×int32.
  if (cellExportOffset > 0 && cellExportCount > 0) {
    r.seek(cellExportOffset);
    r.group("Cell Exports", () => {
      for (let i = 0; i < cellExportCount; i++) {
        r.group(`CellExport[${i}]`, () => {
          r.readInt32("Cpp Class Info Index");
          r.readInt32(); // cpp class info number
          r.readFString("Verse Path");
          r.readInt64("Serial Offset");
          r.readInt64("Serial Layout Size");
          r.readInt64("Serial Size");
          r.readInt32("First Export Dependency");
          r.readInt32("Serialization Before Serialization Deps");
          r.readInt32("Create Before Serialization Deps");
        });
      }
    });
  }

  // Verse Cell Imports — UE5 >= 1015.
  // FCellImport: FPackageIndex + FString.
  if (cellImportOffset > 0 && cellImportCount > 0) {
    r.seek(cellImportOffset);
    r.group("Cell Imports", () => {
      for (let i = 0; i < cellImportCount; i++) {
        r.group(`CellImport[${i}]`, () => {
          r.readInt32("Package Index");
          r.readFString("Verse Path");
        });
      }
    });
  }

  // ── Phase 2.9: Opaque blob sections ──────────────────────────────────────
  // For sections whose internal format is complex or editor-only, annotate the
  // byte range as an opaque blob. Size = distance to the next known section start.
  {
    const allSectionOffsets = [
      nameOffset, softObjectPathsOffset, gatherableTextDataOffset,
      importOffset, exportOffset, cellExportOffset, cellImportOffset,
      dependsOffset, softPackageRefsOffset, searchableNamesOffset,
      thumbnailTableOffset, assetRegistryDataOffset, worldTileInfoOffset,
      preloadDepOffset, dataResourceOffset, importTypeHierarchiesOffset,
      metadataOffset, bulkDataStartOffset, payloadTocOffset, r.byteLength,
    ].filter(o => o > 0).sort((a, b) => a - b);

    const blobSize = (offset: number): number => {
      const next = allSectionOffsets.find(o => o > offset);
      return next !== undefined ? next - offset : 0;
    };

    // Gatherable Text Data — UE4 >= 459 (editor-only text localization data)
    if (gatherableTextDataOffset > 0 && gatherableTextDataCount > 0) {
      const size = blobSize(gatherableTextDataOffset);
      if (size > 0) { r.seek(gatherableTextDataOffset); r.readBytes(size, "Gatherable Text Data"); }
    }

    // Import Type Hierarchies — UE5 >= 1018 (no source available for format)
    if (importTypeHierarchiesOffset > 0 && importTypeHierarchiesCount > 0) {
      const size = blobSize(importTypeHierarchiesOffset);
      if (size > 0) { r.seek(importTypeHierarchiesOffset); r.readBytes(size, "Import Type Hierarchies"); }
    }

    // Thumbnail Table — editor-only asset preview thumbnails
    // Layout: image data blobs are stored BEFORE the TOC. The TOC (at thumbnailTableOffset)
    // has count + per-entry (className, objectPath, fileOffset). fileOffset points back into
    // the image data region that precedes the TOC.
    if (thumbnailTableOffset > 0) {
      r.seek(thumbnailTableOffset);
      const thumbEntries: { objectPath: string; fileOffset: number }[] = [];
      r.group("Thumbnail Table (TOC)", () => {
        const count = r.readInt32("Thumbnail Count");
        for (let i = 0; i < count; i++) {
          r.group(`Thumbnail TOC[${i}]`, () => {
            const className  = r.readFString("Object Class Name");
            const objectPath = r.readFString("Object Path");
            const fileOffset = r.readInt32("File Offset");
            thumbEntries.push({ objectPath, fileOffset });
            return `${objectPath} @ 0x${fileOffset.toString(16)}`;
          });
        }
        return `${thumbEntries.length} thumbnail(s)`;
      });

      // Parse the actual compressed image data (stored before the TOC).
      for (let i = 0; i < thumbEntries.length; i++) {
        const { objectPath, fileOffset } = thumbEntries[i]!;
        if (fileOffset > 0 && fileOffset < r.byteLength) {
          r.seek(fileOffset);
          r.group(`Thumbnail Data [${i}]: ${objectPath}`, () => {
            const width  = r.readInt32("Image Width");
            const rawH   = r.readInt32("Image Height"); // negative = JPEG, positive = PNG
            const isJPEG = rawH < 0;
            const absH   = Math.abs(rawH);
            if (width > 0 && absH > 0) {
              const dataSize = r.readInt32("Compressed Data Size");
              if (dataSize > 0) {
                r.readBytes(dataSize, isJPEG ? "JPEG Data" : "PNG Data");
              }
            }
            return `${width}×${absH} ${isJPEG ? "JPEG" : "PNG"}`;
          });
        }
      }
    }

    // Asset Registry Data — content browser metadata + dependency flags
    // Format (UE4 >= 519, not cooked):
    //   int64 DependencyDataOffset
    //   int32 ObjectCount
    //   per object: FString path, FString class, int32 tagCount, per tag: FString key + value
    //   [at DependencyDataOffset]: TBitArray ImportUsedInGame + TBitArray SoftPackageUsedInGame + more
    if (assetRegistryDataOffset > 0) {
      r.seek(assetRegistryDataOffset);
      r.group("Asset Registry Data", () => {
        const hasNewFormat =
          fileVersionUE4 >= UE4_ASSETREGISTRY_DEPENDENCYFLAGS &&
          !(packageFlags & PKG_FILTER_EDITOR_ONLY);
        let dependencyDataOffset = -1;
        if (hasNewFormat) {
          dependencyDataOffset = Number(r.readInt64("Dependency Data Offset"));
        }
        const objectCount = r.readInt32("Object Count");
        for (let i = 0; i < objectCount; i++) {
          r.group(`ARObject[${i}]`, () => {
            const objectPath = r.readFString("Object Path");
            const className  = r.readFString("Class Name");
            const tagCount   = r.readInt32("Tag Count");
            for (let j = 0; j < tagCount; j++) {
              r.group(`Tag[${j}]`, () => {
                const key   = r.readFString("Key");
                const value = r.readFString("Value");
                return `${key} = ${value}`;
              });
            }
            return `${objectPath} (${className})`;
          });
        }
        // Dependency data: TBitArray per import/soft-package-ref (opaque, complex format)
        if (hasNewFormat && dependencyDataOffset > 0 && dependencyDataOffset < r.byteLength) {
          r.seek(dependencyDataOffset);
          const depSize = blobSize(dependencyDataOffset);
          if (depSize > 0) {
            r.readBytes(depSize, "Asset Registry Dependency Data");
          }
        }
      });
    }

    // World Tile Info — UE4 >= 224 (level streaming metadata)
    if (worldTileInfoOffset > 0) {
      const size = blobSize(worldTileInfoOffset);
      if (size > 0) { r.seek(worldTileInfoOffset); r.readBytes(size, "World Tile Info Data"); }
    }

    // Exports footer tag — 4-byte PACKAGE_FILE_TAG written before the PackageTrailer.
    // Written immediately before PayloadTocOffset when a PackageTrailer exists.
    if (bulkDataStartOffset > 0 && payloadTocOffset > 0 &&
        payloadTocOffset === bulkDataStartOffset + 4) {
      r.seek(bulkDataStartOffset);
      r.readUint32("Exports Footer Tag");
    }

    // Package Trailer — UE5 >= 1002 (bulk/payload data in new format)
    // Layout: FHeader (28 + NumPayloads*49 bytes) | payload blobs | FFooter (20 bytes)
    // FLookupTableEntry: FIoHash(20) + int64 OffsetInFile + int64 CompressedSize +
    //                    uint64 RawSize + uint16 Flags + uint16 FilterFlags + uint8 AccessMode = 49 bytes
    if (payloadTocOffset > 0 && payloadTocOffset < r.byteLength) {
      r.seek(payloadTocOffset);
      r.group("Package Trailer", () => {
        const headerTag         = r.readBytes(8, "Header Tag");
        const trailerVersion    = r.readInt32("Version");
        const headerLength      = r.readUint32("Header Length");
        const payloadsDataLen   = Number(r.readUint64("Payloads Data Length"));
        const numPayloads       = r.readInt32("Num Payloads");

        const payloadEntries: { id: string; offset: number; compSize: number; rawSize: bigint }[] = [];
        for (let i = 0; i < numPayloads; i++) {
          r.group(`Payload[${i}]`, () => {
            const id          = Array.from(r.readBytes(20)).map(b => b.toString(16).padStart(2, "0")).join("");
            const offsetInFile = Number(r.readInt64("Offset In File"));
            const compSize    = Number(r.readInt64("Compressed Size"));
            const rawSize     = r.readUint64("Raw Size");
            r.readUint16("Flags");
            r.readUint16("Filter Flags");
            r.readUint8("Access Mode");
            payloadEntries.push({ id, offset: offsetInFile, compSize, rawSize });
            return `${id.slice(0, 16)}… ${compSize}B compressed, ${rawSize}B raw`;
          });
        }

        // Payload data blobs (local entries)
        const payloadDataStart = payloadTocOffset + headerLength;
        for (let i = 0; i < payloadEntries.length; i++) {
          const entry = payloadEntries[i]!;
          if (entry.offset >= 0 && entry.compSize > 0) {
            r.seek(payloadDataStart + entry.offset);
            r.readBytes(entry.compSize, `Payload Data [${i}]`);
          }
        }

        // Footer (20 bytes: uint64 Tag + uint64 TrailerLength + uint32 PackageTag)
        const footerOffset = payloadDataStart + payloadsDataLen;
        if (footerOffset < r.byteLength) {
          r.seek(footerOffset);
          r.group("Footer", () => {
            r.readBytes(8, "Footer Tag");
            r.readUint64("Trailer Length");
            r.readUint32("Package Tag");
          });
        }
      });
    }

    // Metadata — UE5 >= 1014 (editor asset metadata)
    // Format:
    //   int32 NumObjectMetaDataMap
    //   int32 NumRootMetaDataMap
    //   per ObjectMeta: int32 softObjectPathIndex + TMap<FName, FString>
    //   per RootMeta:   FName (2 int32) + FString
    //
    // FSoftObjectPath in the package body is stored as a single int32 index into the
    // Soft Object Paths table in the header (see FLinkerLoad::operator<< FSoftObjectPath).
    if (metadataOffset > 0) {
      r.seek(metadataOffset);
      r.group("Metadata", () => {
        const numObjectMeta = r.readInt32("Num Object Metadata Entries");
        const numRootMeta   = r.readInt32("Num Root Metadata Entries");
        for (let i = 0; i < numObjectMeta; i++) {
          r.group(`ObjectMeta[${i}]`, () => {
            // FSoftObjectPath serialized as int32 index into softObjectPaths table.
            const pathIdx = r.readInt32("Soft Object Path Index");
            const path    = softObjectPaths[pathIdx] ?? `<softpath#${pathIdx}>`;
            // TMap<FName, FString>: int32 count + per-entry: FName (2 int32) + FString
            const mapCount = r.readInt32("Tag Count");
            for (let j = 0; j < mapCount; j++) {
              r.group(`Tag[${j}]`, () => {
                const keyIdx = r.readInt32("Key Index");
                r.readInt32(); // key name number
                const value  = r.readFString("Value");
                return `${resolveName(names, keyIdx)} = ${value}`;
              });
            }
            return path;
          });
        }
        for (let i = 0; i < numRootMeta; i++) {
          r.group(`RootMeta[${i}]`, () => {
            const keyIdx = r.readInt32("Key Index");
            r.readInt32(); // key name number
            const value  = r.readFString("Value");
            return `${resolveName(names, keyIdx)} = ${value}`;
          });
        }
      });
    }
  }

  // ── Phase 3: Export data ──────────────────────────────────────────────────

  const primaryExport = exports.find(e => e.isAsset) ?? exports[0];
  const assetClass = primaryExport
    ? resolveClass(imports, exports, names, primaryExport.classIndex)
    : "";

  for (const exp of exports) {
    const cls    = resolveClass(imports, exports, names, exp.classIndex);
    const offset = Number(exp.serialOffset);
    const size   = Number(exp.serialSize);
    if (offset <= 0 || size <= 0) continue;

    r.seek(offset);
    dispatchExport(
      r, cls, offset, size, names, fileVersionUE4, fileVersionUE5,
      Number(exp.scriptSerializationStartOffset),
      Number(exp.scriptSerializationEndOffset),
    );
  }

  // ── Build result ──────────────────────────────────────────────────────────

  const summary: AssetSummary = {
    assetClass,
    packageName,
    engineVersion: savedEngineVersionStr,
    customVersions,
    properties: [],
    nameCount: names.length,
    exports: exports.map((exp, i) => ({
      index: i,
      objectName: resolveName(names, exp.objectName),
      className:  resolveClass(imports, exports, names, exp.classIndex),
      serialOffset: Number(exp.serialOffset),
      serialSize:   Number(exp.serialSize),
      isAsset: exp.isAsset,
    })),
    imports: imports.map((imp, i) => ({
      index: -(i + 1),
      classPackage: resolveName(names, imp.classPackage),
      className:    resolveName(names, imp.className),
      objectName:   resolveName(names, imp.objectName),
    })),
  };

  return {
    ranges: r.getAnnotations(),
    totalBytes: buffer.byteLength,
    summary,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveName(names: string[], index: number): string {
  if (index < 0 || index >= names.length) return `<name#${index}>`;
  return names[index]!;
}

/**
 * Resolve a class name from an object index (positive = export, negative = import, 0 = UClass).
 * Object indices are 1-based (UE convention); 0 means "this package" / UClass.
 */
function resolveClass(
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
