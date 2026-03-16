/**
 * UStaticMesh export parser.
 *
 * Handles parsing the native (non-tagged-property) portions of a StaticMesh
 * export: the Export Tail that follows the tagged-property block, plus any
 * Export Header that precedes it.
 *
 * Relevant UE source: Engine/Source/Runtime/Engine/Private/StaticMesh.cpp
 *   UStaticMesh::Serialize          (~line 7188)
 *   FStaticMeshRenderData::Serialize (~line 2469)
 *   FStaticMeshLODResources::Serialize (~line 870)
 *   FStaticMeshLODResources::SerializeBuffers (~line 620)
 */

import type { BinaryReader } from "../reader.ts";
import { registerParser } from "../dispatch.ts";
import { parseTaggedProperties } from "../tagged-properties.ts";

// ── UE4 version constants (see Engine/Source/Runtime/Core/Public/UObject/ObjectVersion.h) ──
// VER_UE4_OLDEST_LOADABLE_PACKAGE = 214; values below are 214 + enum-offset.
const VER_UE4_STATIC_MESH_STORE_NAV_COLLISION = 216;
const VER_UE4_SPEEDTREE_STATICMESH            = 235;

// ── Custom version GUIDs (from Engine/Source/Runtime/Core/Private/UObject/DevObjectVersion.cpp) ──
const GUID_FRenderingObjectVersion            = "12F88B9F-88754AFC-A67CD90C-383ABD29";
const GUID_FEditorObjectVersion               = "E4B068ED-F49442E9-A231DA0B-2E46BB41";
const GUID_FFortniteMainBranchObjectVersion   = "601D1886-AC644F84-AA16D3DE-0DEAC7D6";
const GUID_FUE5ReleaseStreamObjectVersion     = "D89B5E42-24BD4D46-8412ACA8-DF641779";

// FRenderingObjectVersion::TextureStreamingMeshUVChannelData = 10
const RV_TextureStreamingMeshUVChannelData = 10;
// FRenderingObjectVersion::StaticMeshSectionForceOpaqueField = 22 (approx; controls bForceOpaque field in sections)
// Note: for modern assets (v49) this is always present.

// FEditorObjectVersion::RefactorMeshEditorMaterials = 8
const EV_RefactorMeshEditorMaterials = 8;

// FFortniteMainBranchObjectVersion::MeshMaterialSlotOverlayMaterialAdded = 196
const FNV_MeshMaterialSlotOverlayMaterialAdded = 196;

// FUE5ReleaseStreamObjectVersion::RemovingTessellation = 3
const UE5R_RemovingTessellation = 3;

// FUE5ReleaseStreamObjectVersion::StaticMeshSectionExtraStripFlags = 7 (controls CDSF bits in sections)
// For modern assets these are always written.

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Read FName as 2 × int32 (index + instance number) and return the display string. */
function readFName(r: BinaryReader, names: string[], label: string): string {
  return r.group(label, () => {
    const idx    = r.readInt32("Name Index");
    const number = r.readInt32("Name Number");
    const base   = idx >= 0 && idx < names.length ? names[idx] : `<name#${idx}>`;
    return number > 0 ? `${base}_${number - 1}` : base;
  });
}

/** Read FGuid (4 × uint32) and return it as a formatted string. */
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
 * Read a UObject pointer (package index as int32).
 * Positive = export (1-based), negative = import (1-based), 0 = None.
 */
function readObjectRef(r: BinaryReader, label: string): number {
  return r.readInt32(label);
}

/**
 * Serialize a bool as UE4 UBOOL (uint32, 4 bytes).
 */
function readBool32(r: BinaryReader, label: string): boolean {
  return r.readUint32(label) !== 0;
}

// ── FStripDataFlags ───────────────────────────────────────────────────────────

interface StripFlags {
  globalFlags: number;
  classFlags:  number;
}

function readStripDataFlags(r: BinaryReader): StripFlags {
  return r.group("Strip Data Flags", () => {
    const globalFlags = r.readUint8("Global Strip Flags");
    const classFlags  = r.readUint8("Class Strip Flags");
    return { globalFlags, classFlags };
  });
}

function isEditorDataStripped(sf: StripFlags): boolean { return (sf.globalFlags & 1) !== 0; }
function isAVDataStripped(sf: StripFlags):     boolean { return (sf.globalFlags & 2) !== 0; }
function isClassDataStripped(sf: StripFlags, bit: number): boolean { return (sf.classFlags & bit) !== 0; }

// ── FMeshUVChannelInfo ────────────────────────────────────────────────────────

function readMeshUVChannelInfo(r: BinaryReader): void {
  r.group("UV Channel Data", () => {
    readBool32(r, "bInitialized");
    readBool32(r, "bOverrideDensities");
    for (let i = 0; i < 4; i++) {
      r.readFloat32(`LocalUVDensities[${i}]`);
    }
  });
}

// ── FStaticMaterial ───────────────────────────────────────────────────────────

/**
 * FStaticMaterial serialization.
 * Source: StaticMesh.cpp ~line 4515, operator<<(FArchive&, FStaticMaterial&)
 *
 * Fields (for modern UE5 assets with all relevant custom versions met):
 *   MaterialInterface         — object ref (int32)
 *   MaterialSlotName          — FName (2 × int32)
 *   ImportedMaterialSlotName  — FName (2 × int32, editor-only)
 *   UVChannelData             — FMeshUVChannelInfo (2×bool32 + 4×float32 = 24 bytes)
 *   OverlayMaterialInterface  — object ref (int32, if Fortnite version >= 196)
 */
function readStaticMaterial(
  r: BinaryReader,
  names: string[],
  idx: number,
  customVersions: ReadonlyMap<string, number>,
): void {
  const renderingVer  = customVersions.get(GUID_FRenderingObjectVersion)  ?? 0;
  const fortniteVer   = customVersions.get(GUID_FFortniteMainBranchObjectVersion) ?? 0;

  r.group(`StaticMaterial[${idx}]`, () => {
    readObjectRef(r, "MaterialInterface");
    readFName(r, names, "MaterialSlotName");
    readFName(r, names, "ImportedMaterialSlotName");   // editor-only (not filtered in editor builds)

    if (renderingVer >= RV_TextureStreamingMeshUVChannelData) {
      readMeshUVChannelInfo(r);
    }

    if (fortniteVer >= FNV_MeshMaterialSlotOverlayMaterialAdded) {
      readObjectRef(r, "OverlayMaterialInterface");
    }
  });
}

// ── FBoxSphereBounds (float version) ─────────────────────────────────────────

function readFBoxSphereBoundsF(r: BinaryReader, label: string): void {
  r.group(label, () => {
    r.group("Origin", () => {
      r.readFloat32("X"); r.readFloat32("Y"); r.readFloat32("Z");
    });
    r.group("BoxExtent", () => {
      r.readFloat32("X"); r.readFloat32("Y"); r.readFloat32("Z");
    });
    r.readFloat32("SphereRadius");
  });
}

// ── FStaticMeshSection ───────────────────────────────────────────────────────

/**
 * FStaticMeshSection serialization.
 * Source: StaticMesh.cpp ~line 426, operator<<(FArchive&, FStaticMeshSection&)
 */
function readStaticMeshSection(
  r: BinaryReader,
  idx: number,
  customVersions: ReadonlyMap<string, number>,
): void {
  const renderingVer = customVersions.get(GUID_FRenderingObjectVersion) ?? 0;
  // FRenderingObjectVersion::StaticMeshSectionForceOpaqueField: enum value ~22
  const HAS_FORCE_OPAQUE = renderingVer >= 22;

  r.group(`Section[${idx}]`, () => {
    r.readInt32("MaterialIndex");
    r.readUint32("FirstIndex");
    r.readUint32("NumTriangles");
    r.readUint32("MinVertexIndex");
    r.readUint32("MaxVertexIndex");
    readBool32(r, "bEnableCollision");
    readBool32(r, "bCastShadow");
    if (HAS_FORCE_OPAQUE) {
      readBool32(r, "bForceOpaque");
    }
    readBool32(r, "bVisibleInRayTracing");
    readBool32(r, "bAffectDistanceFieldLighting");
  });
}

// ── Vertex Buffer helpers ────────────────────────────────────────────────────

/**
 * TArray::BulkSerialize format:
 *   int32  SerializedElementSize
 *   int32  NumElements
 *   byte[NumElements * SerializedElementSize]  raw data
 */
function readBulkArray(r: BinaryReader, label: string): void {
  r.group(label, () => {
    const elementSize = r.readInt32("Element Size");
    const count       = r.readInt32("Count");
    const byteCount   = count * elementSize;
    if (byteCount > 0) r.readBytes(byteCount, "Data");
  });
}

/**
 * FPositionVertexBuffer::Serialize
 * Source: PositionVertexBuffer.cpp ~line 162
 *   SerializeMetaData: uint32 Stride, uint32 NumVertices
 *   Then TResourceArray::Serialize (BulkSerialize of vertex data)
 */
function readPositionVertexBuffer(r: BinaryReader): void {
  r.group("Position Vertex Buffer", () => {
    const stride      = r.readUint32("Stride");
    const numVertices = r.readUint32("NumVertices");
    if (numVertices > 0) {
      // BulkSerialize: element size (int32) + count (int32) + raw data
      r.readInt32("BulkElementSize");     // should equal stride
      r.readInt32("BulkCount");           // should equal numVertices
      r.readBytes(stride * numVertices, "Vertex Positions");
    }
  });
}

/**
 * FStaticMeshVertexBuffer::Serialize
 * Source: Rendering/StaticMeshVertexBuffer.cpp ~line 203
 *   StripDataFlags (2 bytes)
 *   SerializeMetaData: uint32 NumTexCoords, uint32 NumVertices, bool bFullPrecisionUVs, bool bHighPrecisionTangents
 *   TangentsData (BulkSerialize)
 *   TexcoordData (BulkSerialize)
 */
function readStaticMeshVertexBuffer(r: BinaryReader, outerStripFlags: StripFlags): void {
  r.group("StaticMesh Vertex Buffer", () => {
    // FStripDataFlags with InVersion = VER_UE4_STATIC_SKELETAL_MESH_SERIALIZATION_FIX
    const sf = readStripDataFlags(r);

    // Metadata
    r.readUint32("NumTexCoords");
    r.readUint32("NumVertices");
    readBool32(r, "bUseFullPrecisionUVs");
    readBool32(r, "bUseHighPrecisionTangentBasis");

    if (!isAVDataStripped(sf)) {
      readBulkArray(r, "Tangents Data");
      readBulkArray(r, "TexCoord Data");
    }
  });
}

/**
 * FColorVertexBuffer::Serialize
 * Source: Rendering/ColorVertexBuffer.cpp ~line 184
 *   StripDataFlags (2 bytes)
 *   uint32 Stride, uint32 NumVertices
 *   VertexData (BulkSerialize, only if NumVertices > 0 and not AV-stripped)
 */
function readColorVertexBuffer(r: BinaryReader): void {
  r.group("Color Vertex Buffer", () => {
    const sf = readStripDataFlags(r);
    const stride      = r.readUint32("Stride");
    const numVertices = r.readUint32("NumVertices");
    if (!isAVDataStripped(sf) && numVertices > 0) {
      // BulkSerialize
      r.readInt32("BulkElementSize");
      r.readInt32("BulkCount");
      r.readBytes(stride * numVertices, "Color Data");
    }
  });
}

/**
 * FRawStaticIndexBuffer::Serialize
 * Source: RawIndexBuffer.cpp ~line 399
 *   bool b32Bit (uint32)
 *   TArray<uint8>::BulkSerialize — element size (int32) + count (int32) + raw bytes
 *   bool bShouldExpandTo32Bit (uint32)
 */
function readRawStaticIndexBuffer(r: BinaryReader, label: string): void {
  r.group(label, () => {
    readBool32(r, "b32Bit");
    readBulkArray(r, "Index Data");
    readBool32(r, "bShouldExpandTo32Bit");
  });
}

// ── FRayTracingGeometryOfflineDataHeader ─────────────────────────────────────
// Source: see RayTracingGeometry.h / .cpp — the header is: 4 bytes magic + some fields.
// The exact layout is determined by FRayTracingGeometryOfflineDataHeader.
// For our purposes, we read it as-is using BulkSerialize for the raw data.
// The header struct itself is serialized via Ar << Header (struct).

/** Read FRayTracingGeometry raw data blob. */
function readRayTracingGeometry(r: BinaryReader): void {
  r.group("Ray Tracing Geometry", () => {
    // FRayTracingGeometryOfflineDataHeader: struct with version/size fields.
    // sizeof(FRayTracingGeometryOfflineDataHeader) = 8 bytes based on UE source inspection.
    r.readBytes(8, "RT Geometry Header");
    // FByteBulkData::BulkSerialize
    readBulkArray(r, "RT Geometry Data");
  });
}

// ── FWeightedRandomSampler (base for area-weighted samplers) ─────────────────

/**
 * FWeightedRandomSampler::Serialize — used by FStaticMeshSectionAreaWeightedTriangleSampler.
 * Serializes: TArray<float> Prob, TArray<int32> Alias, float TotalWeight.
 */
function readWeightedSampler(r: BinaryReader, label: string): void {
  r.group(label, () => {
    // TArray<float> Prob
    r.group("Probabilities", () => {
      const count = r.readInt32("Count");
      if (count > 0) r.readBytes(count * 4, "Data");
    });
    // TArray<int32> Alias
    r.group("Aliases", () => {
      const count = r.readInt32("Count");
      if (count > 0) r.readBytes(count * 4, "Data");
    });
    r.readFloat32("TotalWeight");
  });
}

// ── FStaticMeshBuffersSize ───────────────────────────────────────────────────

function readBuffersSize(r: BinaryReader): void {
  r.group("Buffers Size", () => {
    r.readUint32("SerializedBuffersSize");
    r.readUint32("DepthOnlyIBSize");
    r.readUint32("ReversedIBsSize");
  });
}

// ── FStaticMeshLODResources::SerializeBuffers ────────────────────────────────

/**
 * Parses the LOD GPU buffers (vertex buffers + index buffers + ray tracing + samplers).
 * Source: StaticMesh.cpp ~line 620, FStaticMeshLODResources::SerializeBuffers
 *
 * Layout:
 *   FStripDataFlags (class-level, 2 bytes)
 *   PositionVertexBuffer
 *   StaticMeshVertexBuffer
 *   ColorVertexBuffer
 *   IndexBuffer (main)
 *   [if !ClassDataStripped(CDSF_ReversedIndexBuffer)] ReversedIndexBuffer
 *   DepthOnlyIndexBuffer
 *   [if !ClassDataStripped(CDSF_ReversedIndexBuffer)] ReversedDepthOnlyIndexBuffer
 *   [if !editor-stripped] WireframeIndexBuffer
 *   [if loading && UE5Release < RemovingTessellation && !ClassDataStripped(CDSF_AdjacencyData_DEPRECATED)] AdjacencyIndexBuffer
 *   [if !ClassDataStripped(CDSF_RayTracingResources)] RayTracingGeometry
 *   AreaWeightedSectionSamplers[NumSections]
 *   AreaWeightedSampler (mesh-level)
 */
function readSerializeBuffers(
  r: BinaryReader,
  numSections: number,
  customVersions: ReadonlyMap<string, number>,
): void {
  // CDSF bits (ClassDataStripFlags):
  const CDSF_ReversedIndexBuffer     = 1;
  const CDSF_RayTracingResources     = 2;
  const CDSF_AdjacencyData_DEPRECATED = 8;

  const ue5ReleaseVer = customVersions.get(GUID_FUE5ReleaseStreamObjectVersion) ?? 0;

  r.group("Buffers", () => {
    const sf = readStripDataFlags(r);

    readPositionVertexBuffer(r);
    readStaticMeshVertexBuffer(r, sf);
    readColorVertexBuffer(r);

    readRawStaticIndexBuffer(r, "Index Buffer");

    const hasReversed = !isClassDataStripped(sf, CDSF_ReversedIndexBuffer);
    if (hasReversed) {
      readRawStaticIndexBuffer(r, "Reversed Index Buffer");
    }

    readRawStaticIndexBuffer(r, "Depth-Only Index Buffer");

    if (hasReversed) {
      readRawStaticIndexBuffer(r, "Reversed Depth-Only Index Buffer");
    }

    if (!isEditorDataStripped(sf)) {
      readRawStaticIndexBuffer(r, "Wireframe Index Buffer");
    }

    // Legacy adjacency buffer (removed in UE5R >= RemovingTessellation)
    if (ue5ReleaseVer < UE5R_RemovingTessellation && !isClassDataStripped(sf, CDSF_AdjacencyData_DEPRECATED)) {
      readRawStaticIndexBuffer(r, "Adjacency Index Buffer (deprecated)");
    }

    if (!isClassDataStripped(sf, CDSF_RayTracingResources)) {
      readRayTracingGeometry(r);
    }

    for (let i = 0; i < numSections; i++) {
      readWeightedSampler(r, `Area-Weighted Section Sampler[${i}]`);
    }
    readWeightedSampler(r, "Area-Weighted Mesh Sampler");
  });
}

// ── FStaticMeshLODResources::Serialize ──────────────────────────────────────

/**
 * FStaticMeshLODResources::Serialize
 * Source: StaticMesh.cpp ~line 870
 *
 * Layout:
 *   FStripDataFlags (class-level, 2 bytes)
 *   TArray<FStaticMeshSection> Sections
 *   FBoxSphereBounds SourceMeshBounds (float: 7 × float32 = 28 bytes)
 *   float MaxDeviation
 *   bool bIsLODCookedOut
 *   bool bBuffersInlined
 *   if (!AV-stripped && !bIsLODCookedOut):
 *     bool bHasRayTracingGeometry
 *     if (bBuffersInlined):
 *       SerializeBuffers(...)
 *       FStaticMeshBuffersSize
 *     else (streaming/bulk):
 *       StreamingBulkData
 *       SerializeAvailabilityInfo
 *       FStaticMeshBuffersSize
 */
function readLODResources(
  r: BinaryReader,
  lodIndex: number,
  customVersions: ReadonlyMap<string, number>,
): void {
  r.group(`LOD[${lodIndex}]`, () => {
    const sf = readStripDataFlags(r);

    // Sections
    const numSections = r.readInt32("Section Count");
    r.group("Sections", () => {
      for (let i = 0; i < numSections; i++) {
        readStaticMeshSection(r, i, customVersions);
      }
    });

    readFBoxSphereBoundsF(r, "Source Mesh Bounds");
    r.readFloat32("MaxDeviation");

    const bIsLODCookedOut  = readBool32(r, "bIsLODCookedOut");
    const bBuffersInlined  = readBool32(r, "bBuffersInlined");

    if (!isAVDataStripped(sf) && !bIsLODCookedOut) {
      readBool32(r, "bHasRayTracingGeometry");

      if (bBuffersInlined) {
        readSerializeBuffers(r, numSections, customVersions);
        readBuffersSize(r);
      } else {
        // Streaming bulk data — FByteBulkData header + payload
        r.group("Streaming Bulk Data", () => {
          // FByteBulkData serialized via StreamingBulkData.Serialize(Ar, Owner, Index, false)
          // The bulk data format is complex; for simplicity we read the metadata portion.
          // The actual payload may be external (separate .ubulk file).
          // We read what FBulkData::Serialize writes inline:
          //   int32 BulkDataFlags
          //   int64 ElementCount
          //   int64 SizeOnDisk
          //   int64 OffsetInFile
          //   [if payload inline] payload bytes
          r.readInt32("Bulk Data Flags");
          const elementCount = r.readInt64("Element Count");
          const sizeOnDisk   = r.readInt64("Size On Disk");
          r.readInt64("Offset In File");
          // If sizeOnDisk > 0 and data is inline (BulkDataFlags & BULKDATA_PayloadAtEndOfFile == 0)
          // the payload follows here. For non-inlined LODs the payload is in a .ubulk file.
          // We optimistically try reading inline: if sizeOnDisk > 0 and elementCount > 0.
          const byteCount = Number(sizeOnDisk > 0n ? sizeOnDisk : elementCount);
          if (byteCount > 0) {
            r.readBytes(byteCount, "Bulk Payload");
          }
        });

        // SerializeAvailabilityInfo — metadata fields
        r.group("Availability Info", () => {
          r.readUint32("DepthOnlyNumTriangles");
          r.readUint32("Packed Buffer Flags");
          // StaticMeshVertexBuffer metadata (4 × uint32 = 16 bytes)
          r.group("StaticMeshVB Meta", () => {
            r.readUint32("NumTexCoords");
            r.readUint32("NumVertices");
            readBool32(r, "bUseFullPrecisionUVs");
            readBool32(r, "bUseHighPrecisionTangentBasis");
          });
          // PositionVertexBuffer metadata (2 × uint32)
          r.group("PositionVB Meta", () => {
            r.readUint32("Stride");
            r.readUint32("NumVertices");
          });
          // ColorVertexBuffer metadata (2 × uint32)
          r.group("ColorVB Meta", () => {
            r.readUint32("Stride");
            r.readUint32("NumVertices");
          });
          // IndexBuffer metadata
          r.group("IndexBuffer Meta", () => {
            r.readInt32("CachedNumIndices");
            readBool32(r, "b32Bit");
          });
          // Additional index buffers metadata (reversed + depth-only + wireframe + adjacency)
          r.group("ReversedIB Meta",       () => { r.readInt32("CachedNumIndices"); readBool32(r, "b32Bit"); });
          r.group("DepthOnlyIB Meta",      () => { r.readInt32("CachedNumIndices"); readBool32(r, "b32Bit"); });
          r.group("RevDepthOnlyIB Meta",   () => { r.readInt32("CachedNumIndices"); readBool32(r, "b32Bit"); });
          r.group("WireframeIB Meta",      () => { r.readInt32("CachedNumIndices"); readBool32(r, "b32Bit"); });

          const ue5ReleaseVer = customVersions.get(GUID_FUE5ReleaseStreamObjectVersion) ?? 0;
          if (ue5ReleaseVer < UE5R_RemovingTessellation) {
            r.group("AdjacencyIB Meta",    () => { r.readInt32("CachedNumIndices"); readBool32(r, "b32Bit"); });
          }
          // RayTracingGeometry header (8 bytes)
          r.readBytes(8, "RT Geometry Header");
        });

        readBuffersSize(r);
      }
    }
  });
}

// ── FStaticMeshRenderData::Serialize ─────────────────────────────────────────

/**
 * FStaticMeshRenderData::Serialize (cooked path only — bCooked must be true).
 * Source: StaticMesh.cpp ~line 2469
 *
 * For editor (non-cooked) assets this data is not present.
 */
function readRenderData(
  r: BinaryReader,
  customVersions: ReadonlyMap<string, number>,
  endOffset: number,
): void {
  r.group("Render Data", () => {
    // TIndirectArray<FStaticMeshLODResources>
    const numLODs = r.readInt32("Num LODs");
    for (let i = 0; i < numLODs; i++) {
      readLODResources(r, i, customVersions);
    }

    // NumInlinedLODs: uint8
    r.readUint8("NumInlinedLODs");

    // Nanite Resources (Ar << NaniteResourcesPtr->Serialize(...))
    // Nanite is complex — parse as opaque remainder for now.
    // TODO: implement FNaniteResources::Serialize

    // Read remaining bytes as opaque for now
    if (r.pos < endOffset) {
      r.readBytes(endOffset - r.pos, "Remaining Render Data (Nanite + Ray Tracing + Distance Fields)");
    }
  });
}

// ── UStaticMesh export tail ──────────────────────────────────────────────────

/**
 * Parse the Export Tail of a UStaticMesh export — the native serialized data
 * that follows the tagged-property block (scriptEnd) in UStaticMesh::Serialize.
 *
 * The tail consists of (in order):
 *  1. FLazyObjectPtr::PossiblySerializeObjectGuid — bool32 + optional FGuid
 *  2. FStripDataFlags (2 bytes: GlobalStripFlags + ClassStripFlags)
 *  3. bCooked (bool32)
 *  4. BodySetup object ref (int32)
 *  5. NavCollision object ref (int32)                [if UE4 >= 216]
 *  6. LightingGuid (FGuid = 4 × uint32)
 *  7. Sockets (TArray<UStaticMeshSocket*>)
 *  8. [if bCooked] FStaticMeshRenderData
 *  9. bHasSpeedTreeWind (bool32)                     [if UE4 >= 235]
 * 10. TArray<FStaticMaterial> StaticMaterials
 */
function parseStaticMeshTail(
  r: BinaryReader,
  names: string[],
  endOffset: number,
  fileVersionUE4: number,
  customVersions: ReadonlyMap<string, number>,
): void {
  r.group("Native Tail", () => {
    // 1. UObject::PossiblySerializeObjectGuid
    r.group("Object GUID (Lazy Ptr)", () => {
      const hasGuid = readBool32(r, "Has GUID");
      if (hasGuid) readFGuid(r, "GUID");
    });

    // 2. FStripDataFlags
    const stripFlags = readStripDataFlags(r);

    // 3. bCooked
    const bCooked = readBool32(r, "bCooked");

    // 4. BodySetup
    readObjectRef(r, "BodySetup");

    // 5. NavCollision (added in VER_UE4_STATIC_MESH_STORE_NAV_COLLISION = 216)
    if (fileVersionUE4 >= VER_UE4_STATIC_MESH_STORE_NAV_COLLISION) {
      readObjectRef(r, "NavCollision");
    }

    // 6. LightingGuid
    readFGuid(r, "LightingGuid");

    // 7. Sockets
    r.group("Sockets", () => {
      const count = r.readInt32("Count");
      for (let i = 0; i < count; i++) {
        readObjectRef(r, `Socket[${i}]`);
      }
    });

    // 8. Render data (cooked only)
    if (bCooked) {
      readRenderData(r, customVersions, endOffset - /* leave room for tail fields */ 8);
    }

    // 9. SpeedTree wind
    if (fileVersionUE4 >= VER_UE4_SPEEDTREE_STATICMESH) {
      r.group("SpeedTree Wind", () => {
        const hasWind = readBool32(r, "bHasSpeedTreeWind");
        if (hasWind) {
          // FSpeedTreeWind is large; read as opaque
          // TODO: parse FSpeedTreeWind fields
          r.readBytes(endOffset - r.pos - /* staticMaterials TArray prefix */ 4, "SpeedTree Wind Data");
        }
      });
    }

    // 10. Static materials
    const editorVer = customVersions.get(GUID_FEditorObjectVersion) ?? 0;
    if (editorVer >= EV_RefactorMeshEditorMaterials) {
      r.group("Static Materials", () => {
        const count = r.readInt32("Count");
        for (let i = 0; i < count; i++) {
          readStaticMaterial(r, names, i, customVersions);
        }
      });
    }
  });
}

// ── Main entry point ─────────────────────────────────────────────────────────

function parseStaticMeshExport(
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

  // Export Header: native data BEFORE tagged properties (if any)
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

  // Export Tail: native data AFTER tagged properties
  if (absEnd > absScriptEnd) {
    r.seek(absScriptEnd);
    parseStaticMeshTail(r, names, absEnd, fileVersionUE4, customVersions);
  }
}

registerParser("StaticMesh", parseStaticMeshExport);
