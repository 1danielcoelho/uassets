/**
 * UWorld export parser.
 *
 * Relevant UE source:
 *   Engine/Source/Runtime/Engine/Private/World.cpp
 *     UWorld::Serialize (~line 865)
 *   Engine/Source/Runtime/CoreUObject/Private/UObject/Obj.cpp
 *     UObject::Serialize (~line 1646) — tagged props + PossiblySerializeObjectGuid
 *
 * Serialization call chain:
 *   UObject::Serialize  → tagged properties + PossiblySerializeObjectGuid (bool32)
 *   UWorld::Serialize   → PersistentLevel (FPackageIndex)
 *                         [UE4Ver < VER_UE4_ADD_EDITOR_VIEWS / VER_UE4_REMOVE_SAVEGAMESUMMARY:
 *                           old fields — always false for modern UE5 assets]
 *                         ExtraReferencedObjects (TArray<UObject*> — FPackageIndex per element)
 *                         StreamingLevels        (TArray<ULevelStreaming*> — FPackageIndex per element)
 *
 * Non-cooked editor layout (16 bytes for MyMap.umap):
 *   pos  0- 3: PossiblySerializeObjectGuid (bool32=0)
 *   pos  4- 7: PersistentLevel             (int32 = 21 → Export[20])
 *   pos  8-11: ExtraReferencedObjects      (int32 count = 0)
 *   pos 12-15: StreamingLevels             (int32 count = 0)
 */

import type { BinaryReader } from "../reader.ts";
import { registerParser } from "../dispatch.ts";
import { readObjectGuid, readPackageIndex, parseExport } from "../utils.ts";

function readObjectArray(r: BinaryReader, label: string): void {
  r.group(label, () => {
    const count = r.readInt32("Count");
    for (let i = 0; i < count; i++) {
      readPackageIndex(r, `[${i}]`);
    }
  });
}

function parseWorldTail(r: BinaryReader): void {
  r.group("Native Tail", () => {
    readObjectGuid(r);
    readPackageIndex(r, "PersistentLevel");
    readObjectArray(r, "ExtraReferencedObjects");
    readObjectArray(r, "StreamingLevels");
  });
}

registerParser("World", (r, _cls, offset, size, names, _ue4, ue5, scriptStart, scriptEnd) => {
  parseExport(r, offset, size, names, ue5, scriptStart, scriptEnd,
    () => parseWorldTail(r));
});
