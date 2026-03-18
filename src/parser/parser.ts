/**
 * Main UAsset parser.
 *
 * Orchestrates parsing of all sections in a .uasset/.umap file:
 *   1. Fixed header (FPackageFileSummary)
 *   2. Index tables (names, imports, exports)
 *   3. Remaining index tables (depends map, soft object paths, etc.)
 *   4. Opaque blob sections (thumbnails, asset registry, metadata, etc.)
 *   5. Export data (dispatched per class, generic fallback)
 */

import { BinaryReader } from "./reader.ts";
import {
  parsePackageFileSummary,
  type PackageFileSummaryData,
  UE4_64BIT_EXPORTMAP_SERIALSIZES,
  UE4_TEMPLATEINDEX_IN_COOKED_EXPORTS,
  UE4_PRELOAD_DEPENDENCIES_IN_COOKED_EXPORTS,
  UE4_LOAD_FOR_EDITOR_GAME,
  UE4_COOKED_ASSETS_IN_EDITOR_SUPPORT,
  UE4_NON_OUTER_PACKAGE_IMPORT,
  UE4_ASSETREGISTRY_DEPENDENCYFLAGS,
  UE5_OPTIONAL_RESOURCES,
  UE5_REMOVE_OBJECT_EXPORT_PACKAGE_GUID,
  UE5_TRACK_OBJECT_EXPORT_IS_INHERITED,
  UE5_SCRIPT_SERIALIZATION_OFFSET,
  PKG_FILTER_EDITOR_ONLY,
} from "./summary.ts";
import type { FGuid, FObjectImport, FObjectExport } from "./types.ts";
import type { ByteRange } from "../types.ts";
import { resolveName, resolveClass } from "./utils.ts";
import { flagsStr, EObjectFlags, EPackageFlags } from "./enums.ts";
import { dispatchExport } from "./dispatch.ts";
import "./assets/static-mesh.ts";
import "./assets/texture2d.ts";
import "./assets/material.ts";
import "./assets/world.ts";
import "./assets/blueprint.ts";
import { readCompressedBuffer } from "./compressed-buffer.ts";
import { parseTaggedProperties } from "./tagged-properties.ts";
import type { ParseResult, AssetSummary } from "../types.ts";

// ── Package index resolver ────────────────────────────────────────────────────

function resolvePackageIndex(
  imports: FObjectImport[],
  exports: FObjectExport[],
  names: string[],
  idx: number,
): string {
  if (idx === 0) return "None";
  if (idx > 0) {
    const exp = exports[idx - 1];
    return exp ? resolveName(names, exp.objectName) : `<export#${idx}>`;
  }
  const imp = imports[-idx - 1];
  return imp ? resolveName(names, imp.objectName) : `<import#${idx}>`;
}

// ── Names table ───────────────────────────────────────────────────────────────

function parseNamesTable(r: BinaryReader, h: PackageFileSummaryData): string[] {
  const names: string[] = [];
  if (h.nameCount <= 0 || h.nameOffset <= 0) return names;

  r.seek(h.nameOffset);
  r.group("Names Table", () => {
    for (let i = 0; i < h.nameCount; i++) {
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
  return names;
}

// ── Imports table ─────────────────────────────────────────────────────────────

function parseImportsTable(
  r: BinaryReader,
  h: PackageFileSummaryData,
  names: string[],
): FObjectImport[] {
  const imports: FObjectImport[] = [];
  if (h.importCount <= 0 || h.importOffset <= 0) return imports;

  // FName in the import/export map is stored as 2 × int32 (index + instance number).
  // For UE5.7 (fileVersionUE4=522, fileVersionUE5=1018):
  //   - PackageName (FName) added: fileVersionUE4 >= 520 (NON_OUTER_PACKAGE_IMPORT), editor-only
  //   - bImportOptional (bool as int32) added: fileVersionUE5 >= 1003 (OPTIONAL_RESOURCES)
  r.seek(h.importOffset);
  r.group("Imports Table", () => {
    for (let i = 0; i < h.importCount; i++) {
      r.group(`Import[${i}]`, () => {
        const classPackageIdx = r.readInt32("Class Package");
        r.readInt32("Class Package Number");
        const classNameIdx    = r.readInt32("Class Name");
        r.readInt32("Class Name Number");
        const outerIndex      = r.readInt32("Outer Index");
        const objectNameIdx   = r.readInt32("Object Name");
        r.readInt32("Object Name Number");

        // Editor-only: PackageName (FName = 2 × int32) since fileVersionUE4 >= 520
        if (h.fileVersionUE4 >= UE4_NON_OUTER_PACKAGE_IMPORT) {
          r.readInt32("Package Name");
          r.readInt32("Package Name Number");
        }

        // bImportOptional (serialized as int32 in binary archive) since fileVersionUE5 >= 1003
        if (h.fileVersionUE5 >= UE5_OPTIONAL_RESOURCES) {
          r.readInt32("Import Optional");
        }

        const imp: FObjectImport = {
          classPackage: classPackageIdx,
          className:    classNameIdx,
          outerIndex,
          objectName:   objectNameIdx,
        };
        imports.push(imp);
        return `${resolveName(names, classNameIdx)} ${resolveName(names, objectNameIdx)}`;
      });
    }
    return imports;
  });
  return imports;
}

// ── Exports table ─────────────────────────────────────────────────────────────

function parseExportsTable(
  r: BinaryReader,
  h: PackageFileSummaryData,
  names: string[],
): FObjectExport[] {
  const exports: FObjectExport[] = [];
  if (h.exportCount <= 0 || h.exportOffset <= 0) return exports;

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
  r.seek(h.exportOffset);
  r.group("Exports Table", () => {
    for (let i = 0; i < h.exportCount; i++) {
      r.group(`Export[${i}]`, () => {
        const classIndex  = r.readInt32("Class Index");
        const superIndex  = r.readInt32("Super Index");
        const templateIndex = (h.fileVersionUE4 >= UE4_TEMPLATEINDEX_IN_COOKED_EXPORTS)
          ? r.readInt32("Template Index") : 0;
        const outerIndex  = r.readInt32("Outer Index");
        const objectNameIdx = r.readInt32("Object Name");
        r.readInt32("Object Name Number");
        const objectFlags = r.readUint32("Object Flags");
        r.setLastDisplay(flagsStr(objectFlags, EObjectFlags));

        const serialSize   = (h.fileVersionUE4 >= UE4_64BIT_EXPORTMAP_SERIALSIZES)
          ? r.readInt64("Serial Size") : BigInt(r.readInt32("Serial Size"));
        const serialOffset = (h.fileVersionUE4 >= UE4_64BIT_EXPORTMAP_SERIALSIZES)
          ? r.readInt64("Serial Offset") : BigInt(r.readInt32("Serial Offset"));

        const forcedExport = r.readInt32("Forced Export") !== 0;
        const notForClient = r.readInt32("Not For Client") !== 0;
        const notForServer = r.readInt32("Not For Server") !== 0;

        // PackageGuid removed in UE5 >= 1005, but PackageFlags is ALWAYS present
        let packageGuid: FGuid | undefined;
        if (h.fileVersionUE5 < UE5_REMOVE_OBJECT_EXPORT_PACKAGE_GUID) {
          packageGuid = r.readFGuid("Package GUID");
        }

        // bIsInheritedInstance — UE5 >= 1006, serialized BEFORE PackageFlags
        const isInherited =
          (h.fileVersionUE5 >= UE5_TRACK_OBJECT_EXPORT_IS_INHERITED) ? r.readInt32("Is Inherited Instance") !== 0 : false;

        // PackageFlags — always present (even when PackageGuid was removed)
        const exportPackageFlags = r.readUint32("Package Flags");
        r.setLastDisplay(flagsStr(exportPackageFlags, EPackageFlags));

        const notAlwaysLoadedForEditorGame =
          (h.fileVersionUE4 >= UE4_LOAD_FOR_EDITOR_GAME) ? r.readInt32("Not Always Loaded For Editor Game") !== 0 : false;
        const isAsset =
          (h.fileVersionUE4 >= UE4_COOKED_ASSETS_IN_EDITOR_SUPPORT) ? r.readInt32("Is Asset") !== 0 : false;

        // bGeneratePublicHash — UE5 >= 1003 (OPTIONAL_RESOURCES)
        const generatePublicHash =
          (h.fileVersionUE5 >= UE5_OPTIONAL_RESOURCES) ? r.readInt32("Generate Public Hash") !== 0 : false;

        // Preload dependency indices — UE4 >= 507
        let firstExportDep = -1;
        let serBeforeSerDeps = 0, createBeforeSerDeps = 0,
            serBeforeCreateDeps = 0, createBeforeCreateDeps = 0;
        if (h.fileVersionUE4 >= UE4_PRELOAD_DEPENDENCIES_IN_COOKED_EXPORTS) {
          firstExportDep         = r.readInt32("First Export Dependency");
          serBeforeSerDeps       = r.readInt32("Ser Before Ser Dependencies");
          createBeforeSerDeps    = r.readInt32("Create Before Ser Dependencies");
          serBeforeCreateDeps    = r.readInt32("Ser Before Create Dependencies");
          createBeforeCreateDeps = r.readInt32("Create Before Create Dependencies");
        }

        // Script serialization offsets — UE5 >= 1010, serialized AFTER dependency counts
        let scriptSerializationStartOffset = 0n;
        let scriptSerializationEndOffset   = 0n;
        if (h.fileVersionUE5 >= UE5_SCRIPT_SERIALIZATION_OFFSET) {
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
        return resolveName(names, objectNameIdx);
      });
    }
    return exports;
  });
  return exports;
}

// ── Remaining index tables ────────────────────────────────────────────────────

/**
 * Parse the depends map, soft object paths, soft package references,
 * searchable names, preload dependencies, data resources, and Verse cells.
 * Returns the soft object paths array (needed by metadata parsing).
 */
function parseIndexTables(
  r: BinaryReader,
  h: PackageFileSummaryData,
  names: string[],
  importsList: FObjectImport[],
  exportsList: FObjectExport[],
): string[] {
  // Depends Map — one TArray<FPackageIndex> per export.
  if (h.dependsOffset > 0 && h.exportCount > 0) {
    r.seek(h.dependsOffset);
    r.group("Depends Map", () => {
      for (let i = 0; i < h.exportCount; i++) {
        r.group(`Depends[${i}]`, () => {
          const count = r.readInt32();
          const resolved: string[] = [];
          for (let j = 0; j < count; j++) {
            const idx = r.readInt32();
            resolved.push(resolvePackageIndex(importsList, exportsList, names, idx));
          }
          return resolved.length > 0 ? resolved.join(", ") : "(none)";
        });
      }
    });
  }

  // Soft Object Paths — UE5 >= 1008.
  // Each FSoftObjectPath = FTopLevelAssetPath (2 × FName = 4 × int32) + FString subpath.
  // When FSoftObjectPath appears in the package body it is serialized as a single
  // int32 index into this table (see FLinkerLoad).
  const softObjectPaths: string[] = [];
  if (h.softObjectPathsOffset > 0 && h.softObjectPathsCount > 0) {
    r.seek(h.softObjectPathsOffset);
    r.group("Soft Object Paths", () => {
      for (let i = 0; i < h.softObjectPathsCount; i++) {
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
  if (h.softPackageRefsOffset > 0 && h.softPackageRefsCount > 0) {
    r.seek(h.softPackageRefsOffset);
    r.group("Soft Package References", () => {
      for (let i = 0; i < h.softPackageRefsCount; i++) {
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
  if (h.searchableNamesOffset > 0) {
    r.seek(h.searchableNamesOffset);
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
  if (h.preloadDepOffset > 0 && h.preloadDepCount > 0) {
    r.seek(h.preloadDepOffset);
    r.group("Preload Dependencies", () => {
      for (let i = 0; i < h.preloadDepCount; i++) {
        r.readInt32(`Dep[${i}]`);
      }
    });
  }

  // Data Resources — UE5 >= 1009.
  if (h.dataResourceOffset > 0) {
    r.seek(h.dataResourceOffset);
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
  if (h.cellExportOffset > 0 && h.cellExportCount > 0) {
    r.seek(h.cellExportOffset);
    r.group("Cell Exports", () => {
      for (let i = 0; i < h.cellExportCount; i++) {
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
  if (h.cellImportOffset > 0 && h.cellImportCount > 0) {
    r.seek(h.cellImportOffset);
    r.group("Cell Imports", () => {
      for (let i = 0; i < h.cellImportCount; i++) {
        r.group(`CellImport[${i}]`, () => {
          r.readInt32("Package Index");
          r.readFString("Verse Path");
        });
      }
    });
  }

  return softObjectPaths;
}

// ── Opaque and structured blob sections ───────────────────────────────────────

/**
 * Parse the opaque/structured sections that do not belong to the main index tables:
 * gatherable text data, import type hierarchies, thumbnail table, asset registry data,
 * world tile info, exports footer tag, package trailer.
 */
function parseOpaqueBlobs(
  r: BinaryReader,
  h: PackageFileSummaryData,
  names: string[],
): AssetSummary["thumbnail"] {
  // IMPORTANT: Every section offset field from PackageFileSummaryData must be listed here.
  // blobSize() finds a section's size by scanning for the next known offset — if a new
  // section is added to the header but its offset is omitted here, it will silently
  // over-read into the following section.
  const allSectionOffsets = [
    h.nameOffset, h.softObjectPathsOffset, h.gatherableTextDataOffset,
    h.importOffset, h.exportOffset, h.cellExportOffset, h.cellImportOffset,
    h.dependsOffset, h.softPackageRefsOffset, h.searchableNamesOffset,
    h.thumbnailTableOffset, h.assetRegistryDataOffset, h.worldTileInfoOffset,
    h.preloadDepOffset, h.dataResourceOffset, h.importTypeHierarchiesOffset,
    h.metadataOffset, h.bulkDataStartOffset, h.payloadTocOffset, r.byteLength,
  ].filter(o => o > 0).sort((a, b) => a - b);

  const blobSize = (offset: number): number => {
    const next = allSectionOffsets.find(o => o > offset);
    return next !== undefined ? next - offset : 0;
  };

  // Gatherable Text Data — UE4 >= 459 (editor-only text localization data)
  if (h.gatherableTextDataOffset > 0 && h.gatherableTextDataCount > 0) {
    const size = blobSize(h.gatherableTextDataOffset);
    if (size > 0) { r.seek(h.gatherableTextDataOffset); r.readBytes(size, "Gatherable Text Data"); }
  }

  // Import Type Hierarchies — UE5 >= 1018
  if (h.importTypeHierarchiesOffset > 0 && h.importTypeHierarchiesCount > 0) {
    const size = blobSize(h.importTypeHierarchiesOffset);
    if (size > 0) { r.seek(h.importTypeHierarchiesOffset); r.readBytes(size, "Import Type Hierarchies"); }
  }

  // Thumbnail Table — editor-only asset preview thumbnails.
  // Layout: image data blobs are stored BEFORE the TOC. The TOC (at thumbnailTableOffset)
  // has count + per-entry (className, objectPath, fileOffset). fileOffset points back into
  // the image data region that precedes the TOC.
  let primaryThumbnail: AssetSummary["thumbnail"] = undefined;

  if (h.thumbnailTableOffset > 0) {
    // Pass 1: quick unlabeled read of the TOC to collect (objectPath, fileOffset) entries.
    // The data blobs live at lower file offsets than the TOC, so we need the offsets before
    // we can start the wrapper group at the correct byte position.
    r.seek(h.thumbnailTableOffset);
    const thumbCount = r.readInt32();
    const thumbEntries: { objectPath: string; fileOffset: number }[] = [];
    for (let i = 0; i < thumbCount; i++) {
      r.readFString(); // className
      const objectPath = r.readFString();
      const fileOffset = r.readInt32();
      thumbEntries.push({ objectPath, fileOffset });
    }
    const tocEndPos = r.pos;

    // Pass 2: emit a single "Thumbnail Table" group that contains both the data blobs
    // (at lower offsets) and the TOC (at thumbnailTableOffset) as children.
    const validOffsets = thumbEntries.map(e => e.fileOffset).filter(o => o > 0 && o < r.byteLength);
    const groupStart   = validOffsets.length > 0 ? Math.min(...validOffsets) : h.thumbnailTableOffset;
    r.seek(groupStart);
    r.group("Thumbnail Table", () => {
      // Data blobs first (they sit before the TOC in the file)
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
                const imgData = r.readBytes(dataSize, isJPEG ? "JPEG Data" : "PNG Data");
                if (!primaryThumbnail) {
                  primaryThumbnail = {
                    width,
                    height: absH,
                    mimeType: isJPEG ? "image/jpeg" : "image/png",
                    data: imgData.slice(), // detach from the shared ArrayBuffer view
                  };
                }
              }
            }
            return `${width}×${absH} ${isJPEG ? "JPEG" : "PNG"}`;
          });
        }
      }
      // TOC (after the data blobs in the file)
      r.seek(h.thumbnailTableOffset);
      r.group("Thumbnail TOC", () => {
        r.readInt32("Thumbnail Count");
        for (let i = 0; i < thumbEntries.length; i++) {
          r.group(`Thumbnail TOC[${i}]`, () => {
            r.readFString("Object Class Name");
            r.readFString("Object Path");
            r.readInt32("File Offset");
            return `${thumbEntries[i]!.objectPath} @ 0x${thumbEntries[i]!.fileOffset.toString(16)}`;
          });
        }
      });
      r.seek(tocEndPos); // leave cursor at end of TOC so group.end is correct
      return `${thumbCount} thumbnail(s)`;
    });
  }

  // Asset Registry Data — content browser metadata + dependency flags.
  // Format (UE4 >= 519, not cooked):
  //   int64 DependencyDataOffset
  //   int32 ObjectCount
  //   per object: FString path, FString class, int32 tagCount, per tag: FString key + value
  //   [at DependencyDataOffset]: TBitArray ImportUsedInGame + TBitArray SoftPackageUsedInGame + more
  if (h.assetRegistryDataOffset > 0) {
    r.seek(h.assetRegistryDataOffset);
    r.group("Asset Registry Data", () => {
      const hasNewFormat =
        h.fileVersionUE4 >= UE4_ASSETREGISTRY_DEPENDENCYFLAGS &&
        !(h.packageFlags & PKG_FILTER_EDITOR_ONLY);
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
  if (h.worldTileInfoOffset > 0) {
    const size = blobSize(h.worldTileInfoOffset);
    if (size > 0) { r.seek(h.worldTileInfoOffset); r.readBytes(size, "World Tile Info Data"); }
  }

  // Exports footer tag — 4-byte PACKAGE_FILE_TAG written before the PackageTrailer.
  if (h.bulkDataStartOffset > 0 && h.payloadTocOffset > 0 &&
      h.payloadTocOffset === h.bulkDataStartOffset + 4) {
    r.seek(h.bulkDataStartOffset);
    r.readUint32("Exports Footer Tag");
  }

  // Package Trailer — UE5 >= 1002 (bulk/payload data in new format).
  // Layout: FHeader (28 + NumPayloads*49 bytes) | payload blobs | FFooter (20 bytes)
  // FLookupTableEntry: FIoHash(20) + int64 OffsetInFile + int64 CompressedSize +
  //                    uint64 RawSize + uint16 Flags + uint16 FilterFlags + uint8 AccessMode = 49 bytes
  if (h.payloadTocOffset > 0 && h.payloadTocOffset < r.byteLength) {
    r.seek(h.payloadTocOffset);
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

      const payloadDataStart = h.payloadTocOffset + headerLength;
      for (let i = 0; i < payloadEntries.length; i++) {
        const entry = payloadEntries[i]!;
        if (entry.offset >= 0 && entry.compSize > 0) {
          r.seek(payloadDataStart + entry.offset);
          readCompressedBuffer(r, entry.compSize, `Payload Data [${i}]`);
        }
      }

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

  return primaryThumbnail;
}

// ── Metadata ──────────────────────────────────────────────────────────────────

function parseMetadata(
  r: BinaryReader,
  h: PackageFileSummaryData,
  names: string[],
  softObjectPaths: string[],
): number {
  if (h.metadataOffset <= 0) return 0;

  let total = 0;
  r.seek(h.metadataOffset);
  r.group("Metadata", () => {
    // Format:
    //   int32 NumObjectMetaDataMap
    //   int32 NumRootMetaDataMap
    //   per ObjectMeta: int32 softObjectPathIndex + TMap<FName, FString>
    //   per RootMeta:   FName (2 int32) + FString
    //
    // FSoftObjectPath in the package body is stored as a single int32 index into the
    // Soft Object Paths table in the header (see FLinkerLoad::operator<< FSoftObjectPath).
    const numObjectMeta = r.readInt32("Num Object Metadata Entries");
    const numRootMeta   = r.readInt32("Num Root Metadata Entries");
    total += numRootMeta; // each root meta entry is itself one tag
    for (let i = 0; i < numObjectMeta; i++) {
      r.group(`ObjectMeta[${i}]`, () => {
        const pathIdx = r.readInt32("Soft Object Path Index");
        const path    = softObjectPaths[pathIdx] ?? `<softpath#${pathIdx}>`;
        const mapCount = r.readInt32("Tag Count");
        total += mapCount;
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
  return total;
}

// ── Generic export data ───────────────────────────────────────────────────────

/**
 * Parse one export using the generic UObject approach:
 * native header bytes (if any), tagged properties, native tail bytes (if any).
 * Falls back to an opaque blob if script offset bounds are unavailable.
 */
function parseGenericExport(
  r: BinaryReader,
  exp: FObjectExport,
  cls: string,
  names: string[],
  fileVersionUE5: number,
): void {
  // NOTE: Number() conversion is safe for files up to ~2 GB (JS number has 53-bit mantissa).
  // The browser's ArrayBuffer limit is also <2 GB, so this is not a practical concern.
  const offset      = Number(exp.serialOffset);
  const size        = Number(exp.serialSize);
  const scriptStart = Number(exp.scriptSerializationStartOffset);
  const scriptEnd   = Number(exp.scriptSerializationEndOffset);

  if (fileVersionUE5 >= UE5_SCRIPT_SERIALIZATION_OFFSET && scriptEnd > scriptStart) {
    const absScriptStart = offset + scriptStart;
    const absScriptEnd   = offset + scriptEnd;

    if (scriptStart > 0) {
      r.seek(offset);
      r.readBytes(scriptStart, "Export Header");
    }

    r.seek(absScriptStart);
    r.group("Properties", () => {
      parseTaggedProperties(r, names, absScriptEnd, fileVersionUE5);
    });

    const tail = (offset + size) - absScriptEnd;
    if (tail > 0) {
      r.seek(absScriptEnd);
      r.readBytes(tail, "Export Tail");
    }
  } else {
    r.readBytes(size, `Export Data (${cls || "unknown"})`);
  }
}

// ── Main parser ───────────────────────────────────────────────────────────────

export function parseUAsset(buffer: ArrayBuffer): ParseResult {
  const r = new BinaryReader(buffer);

  // Step 1: Fixed header
  const h = r.group("Package Header", () => parsePackageFileSummary(r));

  // Step 2: Core index tables
  const names   = parseNamesTable(r, h);
  const imports = parseImportsTable(r, h, names);
  const exports = parseExportsTable(r, h, names);

  // Step 3: Remaining index tables
  const softObjectPaths = parseIndexTables(r, h, names, imports, exports);

  // Step 4: Opaque and structured blob sections
  const primaryThumbnail = parseOpaqueBlobs(r, h, names);

  // Step 5: Metadata (after opaque blobs; needs softObjectPaths)
  parseMetadata(r, h, names, softObjectPaths);

  // Build custom versions map for asset-specific parsers
  const customVersions: Map<string, number> = new Map(
    h.customVersions.map(cv => [cv.name, cv.version]),
  );

  // Step 6: Export data — all exports under one "Exports" group
  const firstExportOffset = exports
    .map(e => Number(e.serialOffset))
    .filter(o => o > 0)
    .sort((a, b) => a - b)[0];
  if (firstExportOffset !== undefined) r.seek(firstExportOffset);

  r.group("Exports", () => {
    for (const exp of exports) {
      const cls        = resolveClass(imports, exports, names, exp.classIndex);
      const objectName = resolveName(names, exp.objectName);
      const offset     = Number(exp.serialOffset);
      const size       = Number(exp.serialSize);
      if (offset <= 0 || size <= 0) continue;

      r.seek(offset);
      r.group(objectName, () => {
        const handled = dispatchExport(
          r, cls, offset, size, names, h.fileVersionUE4, h.fileVersionUE5,
          Number(exp.scriptSerializationStartOffset),
          Number(exp.scriptSerializationEndOffset),
          customVersions,
        );
        if (!handled) {
          r.seek(offset);
          parseGenericExport(r, exp, cls, names, h.fileVersionUE5);
        }
        return cls;
      });
    }
  });

  // Build result
  const assetClass = (() => {
    const primary = exports.find(e => e.isAsset) ?? exports[0];
    return primary ? resolveClass(imports, exports, names, primary.classIndex) : "";
  })();

  const summary: AssetSummary = {
    assetClass,
    packageName: h.packageName,
    engineVersion: h.savedEngineVersionStr,
    customVersions: h.customVersions,
    properties: [],
    nameCount: names.length,
    thumbnail: primaryThumbnail,
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
    ranges: sortByOffset(r.getAnnotations()),
    totalBytes: buffer.byteLength,
    summary,
  };
}

/** Recursively sort ByteRange arrays by start offset. */
function sortByOffset(ranges: ByteRange[]): ByteRange[] {
  return ranges
    .map(r => r.kind === "group" ? { ...r, children: sortByOffset(r.children) } : r)
    .sort((a, b) => a.start - b.start);
}
