/**
 * Blueprint-related export parsers.
 *
 * Handles the native (non-tagged-property) tails for the exports found in a
 * .uasset Blueprint file. The UBlueprint object itself has no custom native
 * serialization beyond PossiblySerializeObjectGuid; all the interesting data
 * lives in the supporting sub-exports.
 *
 * Relevant UE source:
 *   Engine/Source/Runtime/Engine/Private/Blueprint.cpp
 *     UBlueprintCore::Serialize (~line 287): version registration only
 *     UBlueprint::Serialize     (~line 431): version registration only
 *   Engine/Source/Runtime/CoreUObject/Private/UObject/Class.cpp
 *     UStruct::Serialize: writes TArray<uint8> Script bytecode
 *     UFunction::Serialize: writes FunctionFlags + optional EventGraph refs
 *   Engine/Source/Editor/BlueprintGraph/Private/K2Node.cpp
 *     UK2Node: serializes per-pin data natively (PinCount + variable pin structs)
 *
 * Export classes and their tail layouts (Blueprint.uasset):
 *
 *   Blueprint            (UBlueprint):
 *     4B  PossiblySerializeObjectGuid (bool32=0)
 *
 *   BlueprintGeneratedClass (UBlueprintGeneratedClass → UClass → UStruct):
 *     4B  PossiblySerializeObjectGuid
 *     ??  UClass / UStruct native data (interfaces, reflection, script — opaque)
 *
 *   EdGraph              (UEdGraph):
 *     4B  PossiblySerializeObjectGuid
 *
 *   Function             (UFunction → UStruct → UField → UObject):
 *     4B  PossiblySerializeObjectGuid
 *     ??  UStruct Script (TArray<uint8> bytecode) + UFunction flags (opaque)
 *     Note: the function tail size varies (182B for ExecuteUbergraph, 54B for
 *     ReceiveBeginPlay).  The exact format depends on UE4/5 version handling of
 *     TArray<uint8> and FunctionFlags serialization.
 *
 *   K2Node_CallFunction / K2Node_Event / K2Node_FunctionEntry  (UK2Node):
 *     4B  PossiblySerializeObjectGuid
 *     4B  Serialized pin count  (matches the node's Pins array size)
 *     ??  Serialized pin data   (one variable-length struct per pin, ~200B each)
 *     Note: UK2Node stores per-pin PersistentGuid and connection data natively
 *     in addition to the Pins UPROPERTY.  The per-pin format is complex.
 *
 *   SCS_Node / SimpleConstructionScript (editor sub-objects):
 *     4B  PossiblySerializeObjectGuid
 *
 *   SceneComponent (DefaultSceneRoot_GEN_VARIABLE):
 *     4B  PossiblySerializeObjectGuid
 *     4B  Extra field (null / zero)
 */

import type { BinaryReader } from "../reader.ts";
import { registerParser } from "../dispatch.ts";
import { parseTaggedProperties } from "../tagged-properties.ts";

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

function readObjectGuid(r: BinaryReader): void {
  r.group("Object GUID (Lazy Ptr)", () => {
    const hasGuid = readBool32(r, "Has GUID");
    if (hasGuid) readFGuid(r, "GUID");
  });
}

// ── Shared export-entry boilerplate ──────────────────────────────────────────

/**
 * Standard entry point pattern: optional Export Header + Properties + tail fn.
 */
function parseExport(
  r: BinaryReader,
  offset: number,
  size: number,
  names: string[],
  fileVersionUE5: number,
  scriptStart: number,
  scriptEnd: number,
  parseTailFn: (absEnd: number) => void,
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
    parseTailFn(absEnd);
  }
}

// ── Tail parsers ──────────────────────────────────────────────────────────────

/** UBlueprint tail: only PossiblySerializeObjectGuid (4B). */
function parseBlueprintTail(r: BinaryReader, _end: number): void {
  r.group("Native Tail", () => {
    readObjectGuid(r);
  });
}

/**
 * UBlueprintGeneratedClass tail: PossiblySerializeObjectGuid + opaque UClass
 * data (compiled script, interface table, function map, etc.).
 */
function parseBlueprintGeneratedClassTail(r: BinaryReader, end: number): void {
  r.group("Native Tail", () => {
    readObjectGuid(r);
    if (r.pos < end) {
      r.readBytes(end - r.pos, "UClass Data (opaque)");
    }
  });
}

/** UEdGraph tail: only PossiblySerializeObjectGuid (4B). */
function parseEdGraphTail(r: BinaryReader, _end: number): void {
  r.group("Native Tail", () => {
    readObjectGuid(r);
  });
}

/**
 * UFunction tail: PossiblySerializeObjectGuid + UStruct script bytecode
 * (TArray<uint8>) + UFunction flags and optional EventGraph references.
 * The exact byte layout depends on the UE4/5 TArray<uint8> and BulkData
 * version handling; the data is read as a labeled opaque blob.
 */
function parseFunctionTail(r: BinaryReader, end: number): void {
  r.group("Native Tail", () => {
    readObjectGuid(r);
    if (r.pos < end) {
      r.readBytes(end - r.pos, "Script + FunctionFlags (opaque)");
    }
  });
}

/**
 * UK2Node tail: PossiblySerializeObjectGuid + pin count + per-pin data.
 *
 * UK2Node serializes persistent pin GUIDs and connection data natively
 * (SerializePinData / AllocateDefaultPins) in addition to the Pins
 * UPROPERTY stored in tagged properties.  The per-pin structure is
 * variable-length (~200B each) and complex.
 */
function parseK2NodeTail(r: BinaryReader, end: number): void {
  r.group("Native Tail", () => {
    readObjectGuid(r);
    if (r.pos + 4 <= end) {
      const pinCount = r.readInt32("Serialized Pin Count");
      if (pinCount > 0 && r.pos < end) {
        r.readBytes(end - r.pos, `Serialized Pin Data (${pinCount} pins, opaque)`);
      }
    }
  });
}

/** Simple sub-objects (SCS_Node, SimpleConstructionScript): just GUID. */
function parseSimpleSubObjectTail(r: BinaryReader, _end: number): void {
  r.group("Native Tail", () => {
    readObjectGuid(r);
  });
}

/**
 * SceneComponent sub-objects: PossiblySerializeObjectGuid + 1 extra int32.
 * The extra field is always 0 in the test asset; exact semantics unknown.
 */
function parseSceneComponentTail(r: BinaryReader, end: number): void {
  r.group("Native Tail", () => {
    readObjectGuid(r);
    if (r.pos + 4 <= end) {
      r.readInt32("Extra Field");
    }
  });
}

// ── Registered entry points ───────────────────────────────────────────────────

function makeParseFn(parseTailFn: (r: BinaryReader, end: number) => void) {
  return (
    r: BinaryReader,
    _classname: string,
    offset: number,
    size: number,
    names: string[],
    _fileVersionUE4: number,
    fileVersionUE5: number,
    scriptStart: number,
    scriptEnd: number,
    _customVersions: ReadonlyMap<string, number>,
  ): void => {
    parseExport(r, offset, size, names, fileVersionUE5, scriptStart, scriptEnd,
      (end) => parseTailFn(r, end));
  };
}

// UBlueprint asset object
registerParser("Blueprint",               makeParseFn(parseBlueprintTail));
// Compiled blueprint class
registerParser("BlueprintGeneratedClass", makeParseFn(parseBlueprintGeneratedClassTail));
// Editor graph containers
registerParser("EdGraph",                 makeParseFn(parseEdGraphTail));
// Compiled UFunction objects (ExecuteUbergraph, ReceiveBeginPlay, etc.)
registerParser("Function",                makeParseFn(parseFunctionTail));
// Blueprint graph nodes
registerParser("K2Node_CallFunction",     makeParseFn(parseK2NodeTail));
registerParser("K2Node_Event",            makeParseFn(parseK2NodeTail));
registerParser("K2Node_FunctionEntry",    makeParseFn(parseK2NodeTail));
// Simple editor sub-objects
registerParser("SCS_Node",                makeParseFn(parseSimpleSubObjectTail));
registerParser("SimpleConstructionScript",makeParseFn(parseSimpleSubObjectTail));
// SceneComponent GEN_VARIABLE (variable generated node)
registerParser("SceneComponent",          makeParseFn(parseSceneComponentTail));
