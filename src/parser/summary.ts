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
  readFString,
  readFGuid,
  fGuidToString,
  readFEngineVersion,
  fEngineVersionToString,
  readFCustomVersion,
  readFGenerationInfo,
  readArray,
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

// ── Main parser ───────────────────────────────────────────────────────────────

export function parseUAsset(buffer: ArrayBuffer): ParseResult {
  const r = new BinaryReader(buffer);

  // ── Phase 1: Fixed header ────────────────────────────────────────────────

  const [magic] = r.annotate("Magic Number", "magic", () => r.readUint32(),
    v => `0x${v.toString(16).toUpperCase().padStart(8, "0")}`);

  if (magic !== PACKAGE_FILE_TAG) {
    throw new Error(`Not a UAsset file: magic 0x${magic.toString(16).toUpperCase()} ≠ 0x9E2A83C1`);
  }

  const [legacyFileVersion] = r.annotate("Legacy File Version", "version", () => r.readInt32(),
    v => v.toString());

  if (legacyFileVersion !== -4) {
    r.annotate("Legacy UE3 Version", "version", () => r.readInt32());
  }

  const [fileVersionUE4] = r.annotate("File Version UE4", "version", () => r.readInt32());

  let fileVersionUE5 = 0;
  if (legacyFileVersion <= -8) {
    [fileVersionUE5] = r.annotate("File Version UE5", "version", () => r.readInt32());
  }

  r.annotate("File Version Licensee", "version", () => r.readUint32());

  // SavedHash (FIoHash = 20 bytes) + TotalHeaderSize come BEFORE custom versions
  // when fileVersionUE5 >= PACKAGE_SAVED_HASH (1016).
  let totalHeaderSize = 0;
  if (fileVersionUE5 >= UE5_PACKAGE_SAVED_HASH) {
    r.annotate("Saved Hash (FIoHash)", "guid", () => r.readBytes(20),
      bytes => Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(""));
    [totalHeaderSize] = r.annotate("Total Header Size", "offset", () => r.readInt32(),
      v => `0x${v.toString(16)}`);
  }

  // Custom versions — present when legacyFileVersion <= -2.
  // Format is "Optimized" when legacyFileVersion < -5 (our files have -9).
  // Wire format: TArray where each entry is FGuid (16 bytes) + int32 version = 20 bytes.
  let customVersions: { name: string; version: number }[] = [];
  if (legacyFileVersion <= -2) {
    const [cvs] = r.annotateGroup("Custom Versions", "customver", () => {
      const count = r.readInt32();
      const result: { name: string; version: number }[] = [];
      for (let i = 0; i < count; i++) {
        const [cv] = r.annotateGroup(`Custom Version [${i}]`, "customver", () => {
          const guid = readFGuid(r);
          const ver  = r.readInt32();
          return { guid, version: ver };
        }, v => `${fGuidToString(v.guid)} = ${v.version}`);
        result.push({ name: fGuidToString(cv.guid), version: cv.version });
      }
      return result;
    }, v => `${v.length} entries`);
    customVersions = cvs;
  }

  // TotalHeaderSize comes AFTER custom versions when fileVersionUE5 < PACKAGE_SAVED_HASH.
  if (fileVersionUE5 < UE5_PACKAGE_SAVED_HASH) {
    [totalHeaderSize] = r.annotate("Total Header Size", "offset", () => r.readInt32(),
      v => `0x${v.toString(16)}`);
  }

  const [packageName]  = r.annotate("Package Name",  "string", () => readFString(r));
  const [packageFlags] = r.annotate("Package Flags", "flags",  () => r.readUint32(),
    v => `0x${v.toString(16).padStart(8, "0")}`);

  const [nameCount]  = r.annotate("Name Count",  "offset", () => r.readInt32());
  const [nameOffset] = r.annotate("Name Offset", "offset", () => r.readInt32(),
    v => `0x${v.toString(16)}`);

  // SoftObjectPaths — UE5 >= ADD_SOFTOBJECTPATH_LIST (1008)
  if (fileVersionUE5 >= UE5_ADD_SOFTOBJECTPATH_LIST) {
    r.annotate("Soft Object Paths Count",  "offset", () => r.readInt32());
    r.annotate("Soft Object Paths Offset", "offset", () => r.readInt32(),
      v => `0x${v.toString(16)}`);
  }

  // LocalizationId — editor-only, present when fileVersionUE4 >= 516
  if (fileVersionUE4 >= UE4_ADDED_PACKAGE_SUMMARY_LOCALIZATION_ID) {
    r.annotate("Localization ID", "string", () => readFString(r));
  }

  // Gatherable text data — UE4 >= 459
  if (fileVersionUE4 >= UE4_SERIALIZE_TEXT_IN_PACKAGES) {
    r.annotate("Gatherable Text Data Count",  "offset", () => r.readInt32());
    r.annotate("Gatherable Text Data Offset", "offset", () => r.readInt32(),
      v => `0x${v.toString(16)}`);
  }

  const [exportCount]  = r.annotate("Export Count",  "offset", () => r.readInt32());
  const [exportOffset] = r.annotate("Export Offset", "offset", () => r.readInt32(),
    v => `0x${v.toString(16)}`);
  const [importCount]  = r.annotate("Import Count",  "offset", () => r.readInt32());
  const [importOffset] = r.annotate("Import Offset", "offset", () => r.readInt32(),
    v => `0x${v.toString(16)}`);

  // Verse cells (virtual machine export/import cells) — UE5 >= 1015
  if (fileVersionUE5 >= UE5_VERSE_CELLS) {
    r.annotate("Cell Export Count",  "offset", () => r.readInt32());
    r.annotate("Cell Export Offset", "offset", () => r.readInt32(),
      v => `0x${v.toString(16)}`);
    r.annotate("Cell Import Count",  "offset", () => r.readInt32());
    r.annotate("Cell Import Offset", "offset", () => r.readInt32(),
      v => `0x${v.toString(16)}`);
  }

  // Metadata serialization offset — UE5 >= 1014
  if (fileVersionUE5 >= UE5_METADATA_SERIALIZATION_OFFSET) {
    r.annotate("MetaData Offset", "offset", () => r.readInt32(),
      v => `0x${v.toString(16)}`);
  }

  r.annotate("Depends Offset", "offset", () => r.readInt32(),
    v => `0x${v.toString(16)}`);

  // Soft package references — UE4 >= 384
  if (fileVersionUE4 >= UE4_ADD_STRING_ASSET_REFERENCES_MAP) {
    r.annotate("Soft Package References Count",  "offset", () => r.readInt32());
    r.annotate("Soft Package References Offset", "offset", () => r.readInt32(),
      v => `0x${v.toString(16)}`);
  }

  // Searchable names offset — UE4 >= 510
  if (fileVersionUE4 >= UE4_ADDED_SEARCHABLE_NAMES) {
    r.annotate("Searchable Names Offset", "offset", () => r.readInt32(),
      v => `0x${v.toString(16)}`);
  }

  r.annotate("Thumbnail Table Offset", "offset", () => r.readInt32(),
    v => `0x${v.toString(16)}`);

  // Import type hierarchies (new in UE5 1018)
  if (fileVersionUE5 >= UE5_IMPORT_TYPE_HIERARCHIES) {
    r.annotate("Import Type Hierarchies Count",  "offset", () => r.readInt32());
    r.annotate("Import Type Hierarchies Offset", "offset", () => r.readInt32(),
      v => `0x${v.toString(16)}`);
  }

  // Legacy Guid — only present when fileVersionUE5 < PACKAGE_SAVED_HASH (1016)
  if (fileVersionUE5 < UE5_PACKAGE_SAVED_HASH) {
    r.annotate("GUID (Legacy)", "guid", () => readFGuid(r), fGuidToString);
  }

  // PersistentGuid — editor-only, present when fileVersionUE4 >= 518.
  // OwnerPersistentGuid was added at 518 and removed at 520 (NON_OUTER_PACKAGE_IMPORT).
  if (fileVersionUE4 >= UE4_ADDED_PACKAGE_OWNER) {
    r.annotate("Persistent GUID", "guid", () => readFGuid(r), fGuidToString);
    if (fileVersionUE4 < UE4_NON_OUTER_PACKAGE_IMPORT) {
      r.annotate("Owner Persistent GUID", "guid", () => readFGuid(r), fGuidToString);
    }
  }

  // Generations — TArray<FGenerationInfo>, each 8 bytes (exportCount + nameCount)
  r.annotateGroup("Generations", "version", () =>
    readArray(r, readFGenerationInfo),
    v => `${v.length} generation(s)`);

  // Saved-by engine version
  const [savedEngineVersion] = r.annotateGroup("Saved By Engine Version", "version", () =>
    readFEngineVersion(r), fEngineVersionToString);

  // Compatible-with engine version — UE4 >= 444
  if (fileVersionUE4 >= UE4_PACKAGE_SUMMARY_HAS_COMPATIBLE_ENGINE_VERSION) {
    r.annotateGroup("Compatible With Engine Version", "version", () =>
      readFEngineVersion(r), fEngineVersionToString);
  }

  // Compression flags (should be 0 in modern assets)
  r.annotate("Compression Flags", "flags", () => r.readUint32(),
    v => `0x${v.toString(16).padStart(8, "0")}`);

  // Compressed chunks (should be empty in modern assets)
  r.annotateGroup("Compressed Chunks", "bulk", () =>
    readArray(r, rr => ({
      uncompressedOffset: rr.readInt32(),
      uncompressedSize:   rr.readInt32(),
      compressedOffset:   rr.readInt32(),
      compressedSize:     rr.readInt32(),
    })),
    v => `${v.length} chunk(s)`);

  r.annotate("Package Source", "flags", () => r.readUint32(),
    v => `0x${v.toString(16).padStart(8, "0")}`);

  // Additional packages to cook (legacy field, now always empty)
  r.annotateGroup("Additional Packages To Cook", "string", () =>
    readArray(r, readFString),
    v => `${v.length} entries`);

  // NumTextureAllocations (removed in legacyFileVersion -7, but present in -6 and older)
  if (legacyFileVersion > -7) {
    r.annotate("Num Texture Allocations", "offset", () => r.readInt32());
  }

  const [assetRegistryDataOffset] = r.annotate("Asset Registry Data Offset", "offset",
    () => r.readInt32(), v => `0x${v.toString(16)}`);

  r.annotate("Bulk Data Start Offset", "bulk", () => r.readInt64(),
    v => `0x${v.toString(16)}`);

  // World tile info offset — UE4 >= 224
  if (fileVersionUE4 >= UE4_WORLD_LEVEL_INFO) {
    r.annotate("World Tile Info Data Offset", "offset", () => r.readInt32(),
      v => `0x${v.toString(16)}`);
  }

  // Chunk IDs — UE4 >= 326 uses TArray<int32>, UE4 >= 278 uses single int32
  if (fileVersionUE4 >= UE4_CHANGED_CHUNKID_TO_BE_AN_ARRAY_OF_CHUNKIDS) {
    r.annotateGroup("Chunk IDs", "offset", () =>
      readArray(r, rr => rr.readInt32()),
      v => `${v.length} chunks`);
  } else if (fileVersionUE4 >= UE4_ADDED_CHUNKID_TO_ASSETDATA_AND_UPACKAGE) {
    r.annotate("Chunk ID", "offset", () => r.readInt32());
  }

  // Preload dependency count + offset — UE4 >= 507
  if (fileVersionUE4 >= UE4_PRELOAD_DEPENDENCIES_IN_COOKED_EXPORTS) {
    r.annotate("Preload Dependency Count",  "offset", () => r.readInt32());
    r.annotate("Preload Dependency Offset", "offset", () => r.readInt32(),
      v => `0x${v.toString(16)}`);
  }

  // NamesReferencedFromExportDataCount — UE5 >= 1001
  if (fileVersionUE5 >= UE5_NAMES_REFERENCED_FROM_EXPORT_DATA) {
    r.annotate("Names Referenced From Export Data Count", "offset", () => r.readInt32());
  }

  // PayloadTocOffset — UE5 >= 1002
  if (fileVersionUE5 >= UE5_PAYLOAD_TOC) {
    r.annotate("Payload TOC Offset", "offset", () => r.readInt64(),
      v => `0x${v.toString(16)}`);
  }

  // DataResourceOffset — UE5 >= 1009
  if (fileVersionUE5 >= UE5_DATA_RESOURCES) {
    r.annotate("Data Resource Offset", "offset", () => r.readInt32(),
      v => `0x${v.toString(16)}`);
  }

  // ── Phase 2: Index tables ─────────────────────────────────────────────────

  // Names table
  const names: string[] = [];
  if (nameCount > 0 && nameOffset > 0) {
    r.seek(nameOffset);
    r.annotateGroup("Names Table", "name", () => {
      for (let i = 0; i < nameCount; i++) {
        const [name] = r.annotateGroup(`Name[${i}]`, "name", () => {
          const s = readFString(r);
          // Hash(es) follow each name entry. UE4 >= VER_UE4_NAME_HASHES_SERIALIZED (504):
          // 2 × uint16 = 4 bytes (non-case-preserving + case-preserving hash).
          // All files we support (>= 4.27 = fileVersionUE4 >= ~519) have hashes.
          r.readUint16(); // non-case-preserving hash
          r.readUint16(); // case-preserving hash
          return s;
        }, v => JSON.stringify(v));
        names.push(name);
      }
      return names;
    }, v => `${v.length} names`);
  }

  // Imports table.
  // FName in the import/export map is stored as 2 × int32 (index + instance number).
  // For UE5.7 (fileVersionUE4=522, fileVersionUE5=1018):
  //   - PackageName (FName) added: fileVersionUE4 >= 520 (NON_OUTER_PACKAGE_IMPORT), editor-only
  //   - bImportOptional (bool as int32) added: fileVersionUE5 >= 1003 (OPTIONAL_RESOURCES)
  const imports: FObjectImport[] = [];
  if (importCount > 0 && importOffset > 0) {
    r.seek(importOffset);
    r.annotateGroup("Imports Table", "import", () => {
      for (let i = 0; i < importCount; i++) {
        r.annotateGroup(`Import[${i}]`, "import", () => {
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
        }, imp => {
          const pkg  = resolveName(names, imp.classPackage);
          const cls  = resolveName(names, imp.className);
          const name = resolveName(names, imp.objectName);
          return `${pkg}.${cls} '${name}'`;
        });
      }
      return imports;
    }, v => `${v.length} imports`);
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
    r.annotateGroup("Exports Table", "export", () => {
      for (let i = 0; i < exportCount; i++) {
        r.annotateGroup(`Export[${i}]`, "export", () => {
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

          // PackageGuid (16 bytes) + PackageFlags (uint32) removed in UE5 >= 1005
          let packageGuid = undefined as any;
          let exportPackageFlags = 0;
          if (fileVersionUE5 < UE5_REMOVE_OBJECT_EXPORT_PACKAGE_GUID) {
            packageGuid = readFGuid(r);
            exportPackageFlags = r.readUint32();
          }

          const notAlwaysLoadedForEditorGame =
            (fileVersionUE4 >= UE4_LOAD_FOR_EDITOR_GAME) ? r.readInt32() !== 0 : false;
          const isAsset =
            (fileVersionUE4 >= UE4_COOKED_ASSETS_IN_EDITOR_SUPPORT) ? r.readInt32() !== 0 : false;
          const isInherited =
            (fileVersionUE5 >= UE5_TRACK_OBJECT_EXPORT_IS_INHERITED) ? r.readInt32() !== 0 : false;

          // Script serialization offsets — UE5 >= 1010
          if (fileVersionUE5 >= UE5_SCRIPT_SERIALIZATION_OFFSET) {
            r.readInt64(); // ScriptSerializationStartOffset
            r.readInt64(); // ScriptSerializationEndOffset
          }

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

          const exp: FObjectExport = {
            classIndex, superIndex, templateIndex, outerIndex,
            objectName: objectNameIdx,
            objectFlags, serialSize, serialOffset,
            forcedExport, notForClient, notForServer,
            packageGuid: packageGuid ?? { a: 0, b: 0, c: 0, d: 0 },
            packageFlags: exportPackageFlags,
            notAlwaysLoadedForEditorGame,
            isAsset,
            generatePublicHash: isInherited,
            firstExportDependency: firstExportDep,
            serializationBeforeSerializationDependencies: serBeforeSerDeps,
            createBeforeSerializationDependencies: createBeforeSerDeps,
            serializationBeforeCreateDependencies: serBeforeCreateDeps,
            createBeforeCreateDependencies: createBeforeCreateDeps,
          };
          exports.push(exp);
          return exp;
        }, exp => {
          const name = resolveName(names, exp.objectName);
          const cls  = resolveClass(imports, exports, names, exp.classIndex);
          return `${cls} '${name}' @ 0x${exp.serialOffset.toString(16)} +${exp.serialSize}B`;
        });
      }
      return exports;
    }, v => `${v.length} exports`);
  }

  // ── Phase 3: Export data ──────────────────────────────────────────────────

  const assetClass = exports.length > 0
    ? resolveClass(imports, exports, names, exports[0]!.classIndex)
    : "";

  for (const exp of exports) {
    const cls    = resolveClass(imports, exports, names, exp.classIndex);
    const offset = Number(exp.serialOffset);
    const size   = Number(exp.serialSize);
    if (offset <= 0 || size <= 0) continue;

    r.seek(offset);
    dispatchExport(r, cls, offset, size, names, fileVersionUE4);
  }

  // ── Build result ──────────────────────────────────────────────────────────

  const summary: AssetSummary = {
    assetClass,
    packageName,
    engineVersion: fEngineVersionToString(savedEngineVersion),
    customVersions,
    properties: [],
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
