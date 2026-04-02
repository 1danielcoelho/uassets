/**
 * UStaticMesh export parser.
 *
 * Relevant UE source: Engine/Source/Runtime/Engine/Private/StaticMesh.cpp
 *   UStaticMesh::Serialize          (~line 7188)
 *   FStaticMeshRenderData::Serialize (~line 2469)
 *   FStaticMeshLODResources::Serialize (~line 870)
 *   FStaticMeshLODResources::SerializeBuffers (~line 620)
 */

import type { BinaryReader } from "../reader.ts";
import { registerParser } from "../dispatch.ts";
import {
  GUID_FRenderingObjectVersion,
  GUID_FEditorObjectVersion,
  GUID_FFortniteMainBranchObjectVersion,
  GUID_FUE5ReleaseStreamObjectVersion,
  readBool32, readFGuid, readFName, readPackageIndex,
  StripFlags, readStripDataFlags, isEditorDataStripped, isAVDataStripped, isClassDataStripped,
  readObjectGuid, parseExport,
} from "../utils.ts";

// ── UE4 version constants ─────────────────────────────────────────────────────
// Source: Engine/Source/Runtime/Core/Public/UObject/ObjectVersion.h
const VER_UE4_STATIC_MESH_STORE_NAV_COLLISION = 216;
const VER_UE4_SPEEDTREE_STATICMESH            = 235;

// ── Custom version thresholds ─────────────────────────────────────────────────
// FRenderingObjectVersion::TextureStreamingMeshUVChannelData
const RV_TextureStreamingMeshUVChannelData = 10;
// FRenderingObjectVersion::StaticMeshSectionForceOpaqueField
const RV_StaticMeshSectionForceOpaqueField = 37;
// FRenderingObjectVersion::DeprecatedHighResSourceMesh
const RV_DeprecatedHighResSourceMesh = 49;
// FEditorObjectVersion::RefactorMeshEditorMaterials
const EV_RefactorMeshEditorMaterials = 8;
// FFortniteMainBranchObjectVersion::MeshMaterialSlotOverlayMaterialAdded
const FNV_MeshMaterialSlotOverlayMaterialAdded = 196;
// FUE5ReleaseStreamObjectVersion::RemovingTessellation
const UE5R_RemovingTessellation = 3;

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
 * Fields (modern UE5, all custom versions met):
 *   MaterialInterface         — object ref (int32)
 *   MaterialSlotName          — FName (2 × int32)
 *   ImportedMaterialSlotName  — FName (2 × int32, editor-only)
 *   UVChannelData             — FMeshUVChannelInfo
 *   OverlayMaterialInterface  — object ref (int32, if Fortnite >= 196)
 */
function readStaticMaterial(
  r: BinaryReader,
  names: string[],
  idx: number,
  customVersions: ReadonlyMap<string, number>,
): void {
  const renderingVer = customVersions.get(GUID_FRenderingObjectVersion)          ?? 0;
  const fortniteVer  = customVersions.get(GUID_FFortniteMainBranchObjectVersion) ?? 0;

  r.group(`StaticMaterial[${idx}]`, () => {
    readPackageIndex(r, "MaterialInterface");
    readFName(r, names, "MaterialSlotName");
    readFName(r, names, "ImportedMaterialSlotName");

    if (renderingVer >= RV_TextureStreamingMeshUVChannelData) {
      readMeshUVChannelInfo(r);
    }

    if (fortniteVer >= FNV_MeshMaterialSlotOverlayMaterialAdded) {
      readPackageIndex(r, "OverlayMaterialInterface");
    }
  });
}

// ── FBoxSphereBounds ──────────────────────────────────────────────────────────

function readFBoxSphereBoundsF(r: BinaryReader, label: string): void {
  r.group(label, () => {
    r.group("Origin",    () => { r.readFloat32("X"); r.readFloat32("Y"); r.readFloat32("Z"); });
    r.group("BoxExtent", () => { r.readFloat32("X"); r.readFloat32("Y"); r.readFloat32("Z"); });
    r.readFloat32("SphereRadius");
  });
}

// ── FStaticMeshSection ────────────────────────────────────────────────────────

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
  const hasForceOpaque = renderingVer >= RV_StaticMeshSectionForceOpaqueField;

  r.group(`Section[${idx}]`, () => {
    r.readInt32("MaterialIndex");
    r.readUint32("FirstIndex");
    r.readUint32("NumTriangles");
    r.readUint32("MinVertexIndex");
    r.readUint32("MaxVertexIndex");
    readBool32(r, "bEnableCollision");
    readBool32(r, "bCastShadow");
    if (hasForceOpaque)      readBool32(r, "bForceOpaque");
    readBool32(r, "bVisibleInRayTracing");
    readBool32(r, "bAffectDistanceFieldLighting");
  });
}

// ── Vertex buffer helpers ─────────────────────────────────────────────────────

/** TArray::BulkSerialize: int32 elementSize, int32 count, byte[count*elementSize] data. */
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
 */
function readPositionVertexBuffer(r: BinaryReader): void {
  r.group("Position Vertex Buffer", () => {
    const stride      = r.readUint32("Stride");
    const numVertices = r.readUint32("NumVertices");
    if (numVertices > 0) {
      r.readInt32("BulkElementSize");
      r.readInt32("BulkCount");
      r.readBytes(stride * numVertices, "Vertex Positions");
    }
  });
}

/**
 * FStaticMeshVertexBuffer::Serialize
 * Source: Rendering/StaticMeshVertexBuffer.cpp ~line 203
 */
function readStaticMeshVertexBuffer(r: BinaryReader, _outerSf: StripFlags): void {
  r.group("StaticMesh Vertex Buffer", () => {
    const sf = readStripDataFlags(r);
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
 */
function readColorVertexBuffer(r: BinaryReader): void {
  r.group("Color Vertex Buffer", () => {
    const sf = readStripDataFlags(r);
    const stride      = r.readUint32("Stride");
    const numVertices = r.readUint32("NumVertices");
    if (!isAVDataStripped(sf) && numVertices > 0) {
      r.readInt32("BulkElementSize");
      r.readInt32("BulkCount");
      r.readBytes(stride * numVertices, "Color Data");
    }
  });
}

/**
 * FRawStaticIndexBuffer::Serialize
 * Source: RawIndexBuffer.cpp ~line 399
 */
function readRawStaticIndexBuffer(r: BinaryReader, label: string): void {
  r.group(label, () => {
    readBool32(r, "b32Bit");
    readBulkArray(r, "Index Data");
    readBool32(r, "bShouldExpandTo32Bit");
  });
}

/** FRayTracingGeometry: 8-byte header + BulkSerialize data. */
function readRayTracingGeometry(r: BinaryReader): void {
  r.group("Ray Tracing Geometry", () => {
    r.readBytes(8, "RT Geometry Header");
    readBulkArray(r, "RT Geometry Data");
  });
}

/**
 * FWeightedRandomSampler::Serialize — TArray<float> Prob + TArray<int32> Alias + float TotalWeight.
 * Used by FStaticMeshSectionAreaWeightedTriangleSampler.
 */
function readWeightedSampler(r: BinaryReader, label: string): void {
  r.group(label, () => {
    r.group("Probabilities", () => { const n = r.readInt32("Count"); if (n > 0) r.readBytes(n * 4, "Data"); });
    r.group("Aliases",       () => { const n = r.readInt32("Count"); if (n > 0) r.readBytes(n * 4, "Data"); });
    r.readFloat32("TotalWeight");
  });
}

function readBuffersSize(r: BinaryReader): void {
  r.group("Buffers Size", () => {
    r.readUint32("SerializedBuffersSize");
    r.readUint32("DepthOnlyIBSize");
    r.readUint32("ReversedIBsSize");
  });
}

// ── FStaticMeshLODResources::SerializeBuffers ─────────────────────────────────

/**
 * Source: StaticMesh.cpp ~line 620
 *
 * Layout:
 *   FStripDataFlags (class-level)
 *   PositionVertexBuffer, StaticMeshVertexBuffer, ColorVertexBuffer
 *   IndexBuffer, [ReversedIndexBuffer], DepthOnlyIndexBuffer, [ReversedDepthOnlyIndexBuffer]
 *   [!editor-stripped] WireframeIndexBuffer
 *   [UE5R < RemovingTessellation && !CDSF_AdjacencyData] AdjacencyIndexBuffer
 *   [!CDSF_RayTracingResources] RayTracingGeometry
 *   AreaWeightedSectionSamplers[N] + AreaWeightedSampler
 */
function readSerializeBuffers(
  r: BinaryReader,
  numSections: number,
  customVersions: ReadonlyMap<string, number>,
): void {
  const CDSF_ReversedIndexBuffer      = 1;
  const CDSF_RayTracingResources      = 2;
  const CDSF_AdjacencyData_DEPRECATED = 8;
  const ue5ReleaseVer = customVersions.get(GUID_FUE5ReleaseStreamObjectVersion) ?? 0;

  r.group("Buffers", () => {
    const sf = readStripDataFlags(r);

    readPositionVertexBuffer(r);
    readStaticMeshVertexBuffer(r, sf);
    readColorVertexBuffer(r);

    readRawStaticIndexBuffer(r, "Index Buffer");
    const hasReversed = !isClassDataStripped(sf, CDSF_ReversedIndexBuffer);
    if (hasReversed) readRawStaticIndexBuffer(r, "Reversed Index Buffer");

    readRawStaticIndexBuffer(r, "Depth-Only Index Buffer");
    if (hasReversed) readRawStaticIndexBuffer(r, "Reversed Depth-Only Index Buffer");

    if (!isEditorDataStripped(sf)) readRawStaticIndexBuffer(r, "Wireframe Index Buffer");

    if (ue5ReleaseVer < UE5R_RemovingTessellation && !isClassDataStripped(sf, CDSF_AdjacencyData_DEPRECATED)) {
      readRawStaticIndexBuffer(r, "Adjacency Index Buffer (deprecated)");
    }

    if (!isClassDataStripped(sf, CDSF_RayTracingResources)) readRayTracingGeometry(r);

    for (let i = 0; i < numSections; i++) {
      readWeightedSampler(r, `Area-Weighted Section Sampler[${i}]`);
    }
    readWeightedSampler(r, "Area-Weighted Mesh Sampler");
  });
}

// ── FStaticMeshLODResources::Serialize ────────────────────────────────────────

/**
 * Source: StaticMesh.cpp ~line 870
 *
 * Layout:
 *   FStripDataFlags, TArray<FStaticMeshSection>, FBoxSphereBounds, float MaxDeviation,
 *   bool bIsLODCookedOut, bool bBuffersInlined,
 *   [if !AV-stripped && !bIsLODCookedOut]:
 *     bool bHasRayTracingGeometry
 *     [if bBuffersInlined]: SerializeBuffers + FStaticMeshBuffersSize
 *     [else]: StreamingBulkData + SerializeAvailabilityInfo + FStaticMeshBuffersSize
 */
function readLODResources(
  r: BinaryReader,
  lodIndex: number,
  customVersions: ReadonlyMap<string, number>,
): void {
  r.group(`LOD[${lodIndex}]`, () => {
    const sf = readStripDataFlags(r);

    const numSections = r.readInt32("Section Count");
    r.group("Sections", () => {
      for (let i = 0; i < numSections; i++) readStaticMeshSection(r, i, customVersions);
    });

    readFBoxSphereBoundsF(r, "Source Mesh Bounds");
    r.readFloat32("MaxDeviation");

    const bIsLODCookedOut = readBool32(r, "bIsLODCookedOut");
    const bBuffersInlined = readBool32(r, "bBuffersInlined");

    if (!isAVDataStripped(sf) && !bIsLODCookedOut) {
      readBool32(r, "bHasRayTracingGeometry");

      if (bBuffersInlined) {
        readSerializeBuffers(r, numSections, customVersions);
        readBuffersSize(r);
      } else {
        r.group("Streaming Bulk Data", () => {
          // FBulkData::Serialize — flags + elementCount + sizeOnDisk + offset [+ inline payload]
          r.readInt32("Bulk Data Flags");
          const elementCount = r.readInt64("Element Count");
          const sizeOnDisk   = r.readInt64("Size On Disk");
          r.readInt64("Offset In File");
          const byteCount = Number(sizeOnDisk > 0n ? sizeOnDisk : elementCount);
          if (byteCount > 0) r.readBytes(byteCount, "Bulk Payload");
        });

        r.group("Availability Info", () => {
          r.readUint32("DepthOnlyNumTriangles");
          r.readUint32("Packed Buffer Flags");
          r.group("StaticMeshVB Meta", () => {
            r.readUint32("NumTexCoords"); r.readUint32("NumVertices");
            readBool32(r, "bUseFullPrecisionUVs"); readBool32(r, "bUseHighPrecisionTangentBasis");
          });
          r.group("PositionVB Meta", () => { r.readUint32("Stride"); r.readUint32("NumVertices"); });
          r.group("ColorVB Meta",    () => { r.readUint32("Stride"); r.readUint32("NumVertices"); });
          const readIBMeta = (label: string) => r.group(label, () => {
            r.readInt32("CachedNumIndices"); readBool32(r, "b32Bit");
          });
          readIBMeta("IndexBuffer Meta");
          readIBMeta("ReversedIB Meta");
          readIBMeta("DepthOnlyIB Meta");
          readIBMeta("RevDepthOnlyIB Meta");
          readIBMeta("WireframeIB Meta");
          const ue5ReleaseVer = customVersions.get(GUID_FUE5ReleaseStreamObjectVersion) ?? 0;
          if (ue5ReleaseVer < UE5R_RemovingTessellation) readIBMeta("AdjacencyIB Meta");
          r.readBytes(8, "RT Geometry Header");
        });

        readBuffersSize(r);
      }
    }
  });
}

// ── FStaticMeshRenderData::Serialize ─────────────────────────────────────────

/**
 * Cooked path only (bCooked must be true).
 * Source: StaticMesh.cpp ~line 2469
 * For editor (non-cooked) assets this data is not present.
 */
function readRenderData(
  r: BinaryReader,
  customVersions: ReadonlyMap<string, number>,
  endOffset: number,
): void {
  r.group("Render Data", () => {
    const numLODs = r.readInt32("Num LODs");
    for (let i = 0; i < numLODs; i++) readLODResources(r, i, customVersions);

    r.readUint8("NumInlinedLODs");

    // Nanite resources + remaining render data (opaque; TODO: parse FNaniteResources)
    if (r.pos < endOffset) {
      r.readBytes(endOffset - r.pos, "Remaining Render Data (Nanite + Ray Tracing + Distance Fields)");
    }
  });
}

// ── UStaticMesh export tail ───────────────────────────────────────────────────

/**
 * Native tail of UStaticMesh::Serialize (follows tagged-property block).
 *
 * Layout:
 *  1. PossiblySerializeObjectGuid
 *  2. FStripDataFlags
 *  3. bCooked
 *  4. BodySetup ref
 *  5. NavCollision ref           [if UE4 >= 216]
 *  6. LightingGuid
 *  7. Sockets array
 *  8. FStaticMeshRenderData      [if bCooked]
 *  9. SpeedTree wind             [if UE4 >= 235]
 * 10. TArray<FStaticMaterial>
 */
function parseStaticMeshTail(
  r: BinaryReader,
  names: string[],
  endOffset: number,
  fileVersionUE4: number,
  customVersions: ReadonlyMap<string, number>,
): void {
  r.group("Native Tail", () => {
    readObjectGuid(r);

    const stripFlags = readStripDataFlags(r);
    const bCooked = readBool32(r, "bCooked");

    readPackageIndex(r, "BodySetup");
    if (fileVersionUE4 >= VER_UE4_STATIC_MESH_STORE_NAV_COLLISION) {
      readPackageIndex(r, "NavCollision");
    }

    // WITH_EDITORONLY_DATA: deprecated high-res source mesh fields
    // present when FRenderingObjectVersion < DeprecatedHighResSourceMesh (49)
    const renderingVer = customVersions.get(GUID_FRenderingObjectVersion) ?? 0;
    if (!isEditorDataStripped(stripFlags) && renderingVer < RV_DeprecatedHighResSourceMesh) {
      r.group("Deprecated High-Res Source Mesh", () => {
        r.readFString("HighResSourceMeshName");
        r.readUint32("HighResSourceMeshCRC");
      });
    }

    readFGuid(r, "LightingGuid");

    r.group("Sockets", () => {
      const count = r.readInt32("Count");
      for (let i = 0; i < count; i++) readPackageIndex(r, `Socket[${i}]`);
    });

    if (bCooked) {
      readRenderData(r, customVersions, endOffset - 8);
    }

    if (fileVersionUE4 >= VER_UE4_SPEEDTREE_STATICMESH) {
      r.group("SpeedTree Wind", () => {
        const hasWind = readBool32(r, "bHasSpeedTreeWind");
        if (hasWind) {
          r.readBytes(endOffset - r.pos - 4, "SpeedTree Wind Data");
        }
      });
    }

    const editorVer = customVersions.get(GUID_FEditorObjectVersion) ?? 0;
    if (editorVer >= EV_RefactorMeshEditorMaterials) {
      r.group("Static Materials", () => {
        const count = r.readInt32("Count");
        for (let i = 0; i < count; i++) readStaticMaterial(r, names, i, customVersions);
      });
    }
  });
}

// ── Registration ──────────────────────────────────────────────────────────────

registerParser("StaticMesh", (r, _cls, offset, size, names, ue4, ue5, scriptStart, scriptEnd, cv) => {
  parseExport(r, offset, size, names, ue5, scriptStart, scriptEnd,
    (end) => parseStaticMeshTail(r, names, end, ue4, cv));
});
