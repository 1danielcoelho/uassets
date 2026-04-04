/**
 * FPropertyTag parsing for UE5 tagged-property format.
 *
 * References:
 *   UnrealEngine-5.7.3-release/Engine/Source/Runtime/CoreUObject/Private/UObject/PropertyTag.cpp
 *   UnrealEngine-5.7.3-release/Engine/Source/Runtime/CoreUObject/Private/UObject/PropertyTypeName.cpp
 *   UnrealEngine-5.7.3-release/Engine/Source/Runtime/CoreUObject/Private/UObject/Class.cpp
 *     — UStruct::SerializeVersionedTaggedProperties()
 *
 * === Wire format for UE5 >= PROPERTY_TAG_COMPLETE_TYPE_NAME (version 1012) ===
 *
 * Preamble (for UClass objects, i.e. non-structs, when fileVersionUE5 >= 1011):
 *   uint8 SerializationControlExtension
 *     0x02 OverridableSerializationInformation → uint8 OverridableOperation
 *
 * Tag loop:
 *   FName name  (2 × int32: nameIndex, instanceNumber)
 *     → if resolves to "None", stop (the FName itself is the terminator)
 *   FPropertyTypeName type  (N nodes × 12 bytes; N determined by InnerCount fields)
 *   int32 size   (value byte count, EXCLUDING tag header)
 *   uint8 flags  (EPropertyTagFlags bitmask):
 *     HasArrayIndex             0x01  → int32 arrayIndex
 *     HasPropertyGuid           0x02  → FGuid (16 bytes)
 *     HasPropertyExtensions     0x04  → uint8 extFlags;
 *                                         if OverridableInformation 0x02: +uint8 + uint8
 *     HasBinaryOrNativeSerialize 0x08 (value still has `size` bytes)
 *     BoolTrue                  0x10  (bool value encoded in flags; size == 0)
 *     SkippedSerialize          0x20  (value still has `size` bytes; just skipped during load)
 *   [value: size bytes]
 *
 * === Wire format for older packages (version < 1012) ===
 *   FName name, FName type, int32 size, int32 arrayIndex,
 *   type-specific header, uint8 hasPropertyGuid, [FGuid], [value: size bytes]
 */

import { BinaryReader } from "./reader.ts";
import { flagsStr8, EPropertyTagFlags, EPropertyTagExtension, EClassSerializationControlExtension } from "./enums.ts";
import { readFName } from "./utils.ts";

// EPropertyTagFlags
const FLAG_HAS_ARRAY_INDEX            = 0x01;
const FLAG_HAS_PROPERTY_GUID          = 0x02;
const FLAG_HAS_PROPERTY_EXTENSIONS    = 0x04;
const FLAG_HAS_BINARY_OR_NATIVE       = 0x08;
// BoolTrue = 0x10  (bool value is in flags, not in value bytes — size will be 0)
// SkippedSerialize = 0x20 (size bytes present but skipped)

// EPropertyTagExtension
const EXT_OVERRIDABLE_INFO = 0x02;

// EClassSerializationControlExtension
const CTRL_EXT_OVERRIDABLE_SERIALIZATION = 0x02;

// UE5 version thresholds (counted from INITIAL_VERSION = 1000)
const UE5_PROPERTY_TAG_EXTENSION_AND_OVERRIDABLE_SERIALIZATION = 1011;
const UE5_PROPERTY_TAG_COMPLETE_TYPE_NAME                      = 1012;

// ── FPropertyTypeName ──────────────────────────────────────────────────────────

/** Parsed FPropertyTypeName node. */
interface PropType {
  name: string;
  params: PropType[];
}

/** Convert a PropType tree to its display string. */
function propTypeStr(t: PropType): string {
  return t.params.length === 0
    ? t.name
    : `${t.name}<${t.params.map(propTypeStr).join(", ")}>`;
}

/**
 * Read one node of an FPropertyTypeName from the binary archive (unlabeled).
 *
 * Each node: FName (2 × int32) + int32 InnerCount = 12 bytes.
 * InnerCount is the number of direct child nodes, read recursively.
 */
function readTypeNameNode(r: BinaryReader, names: string[]): PropType {
  const ni = r.readInt32();
  r.readInt32(); // instance number
  const ic = r.readInt32(); // InnerCount (number of direct children)
  const name = names[ni] ?? `<name#${ni}>`;
  const params: PropType[] = [];
  for (let i = 0; i < ic; i++) params.push(readTypeNameNode(r, names));
  return { name, params };
}

// ── Native struct readers ──────────────────────────────────────────────────────

/** Annotated readers for known native-binary structs (HasBinaryOrNativeSerialize). */
const NATIVE_STRUCT_READERS: Record<string, (r: BinaryReader) => void> = {
  Guid:          r => { r.readFGuid("Value"); },
  LinearColor:   r => { r.readFloat32("R"); r.readFloat32("G"); r.readFloat32("B"); r.readFloat32("A"); },
  Color:         r => { r.readUint8("B"); r.readUint8("G"); r.readUint8("R"); r.readUint8("A"); },
  Vector:        r => { r.readFloat64("X"); r.readFloat64("Y"); r.readFloat64("Z"); },
  Vector2D:      r => { r.readFloat64("X"); r.readFloat64("Y"); },
  Vector4:       r => { r.readFloat64("X"); r.readFloat64("Y"); r.readFloat64("Z"); r.readFloat64("W"); },
  Quat:          r => { r.readFloat64("X"); r.readFloat64("Y"); r.readFloat64("Z"); r.readFloat64("W"); },
  Rotator:       r => { r.readFloat64("Pitch"); r.readFloat64("Yaw"); r.readFloat64("Roll"); },
  IntPoint:      r => { r.readInt32("X"); r.readInt32("Y"); },
  IntVector:     r => { r.readInt32("X"); r.readInt32("Y"); r.readInt32("Z"); },
  Box2D:         r => { r.readFloat64("Min.X"); r.readFloat64("Min.Y"); r.readFloat64("Max.X"); r.readFloat64("Max.Y"); r.readUint8("IsValid"); },
  Box:           r => { r.readFloat64("Min.X"); r.readFloat64("Min.Y"); r.readFloat64("Min.Z"); r.readFloat64("Max.X"); r.readFloat64("Max.Y"); r.readFloat64("Max.Z"); r.readUint8("IsValid"); },
};

/** Read an FText value, emitting a group annotation with label. */
function readTextAnnotation(r: BinaryReader, label: string, valueEnd: number): void {
  r.group(label, () => {
    r.readInt32("Flags");
    const historyRaw = r.readUint8("History Type");
    const historyType = historyRaw > 127 ? historyRaw - 256 : historyRaw; // signed int8
    switch (historyType) {
      case -1: { // None
        const hasCulture = r.readUint8("Has Culture Invariant String");
        if (hasCulture) r.readFString("Culture Invariant String");
        break;
      }
      case 0: // Base
        r.readFString("Namespace");
        r.readFString("Key");
        r.readFString("Source String");
        break;
      case 11: // StringTableEntry
        r.readFString("Table Id");
        r.readFString("Key");
        break;
      default:
        // Unrecognised history type; remaining bytes handled by outer safety fallback.
        break;
    }
    // Safety: consume any bytes not parsed by the switch above.
    if (r.pos < valueEnd) r.readBytes(valueEnd - r.pos, "Remaining Text Data");
  });
}

// ── Property value dispatch ────────────────────────────────────────────────────

/**
 * Read and annotate the value bytes for a single property.
 *
 * On return r.pos should equal valueEnd; if it falls short the caller adds a
 * "Remaining Value" annotation for the unconsumed tail.
 *
 * @param r            Reader positioned at the start of the value bytes.
 * @param names        Package name table.
 * @param propType     Parsed property type (root node of FPropertyTypeName).
 * @param hasNative    True when HasBinaryOrNativeSerialize (0x08) is set on the tag.
 * @param valueEnd     Exclusive end offset for this value.
 * @param fileVersionUE5  UE5 custom version (needed for recursive struct parsing).
 * @param label        Annotation label.
 */
function readPropertyValue(
  r: BinaryReader,
  names: string[],
  propType: PropType,
  hasNative: boolean,
  valueEnd: number,
  fileVersionUE5: number,
  label: string,
): void {
  if (r.pos >= valueEnd) return;

  switch (propType.name) {
    // ── Boolean ─────────────────────────────────────────────────────────────
    case "BoolProperty":
      // Value is encoded in the tag flags (BoolTrue = 0x10); size == 0.
      break;

    // ── Integer scalars ──────────────────────────────────────────────────────
    case "Int8Property":
      r.readUint8(label); break; // serialized as uint8, 1 byte

    case "ByteProperty":
    case "EnumProperty": {
      const sz = valueEnd - r.pos;
      if (sz === 1) {
        r.readUint8(label);
      } else {
        // Enum value stored as FName (8 bytes)
        readFName(r, names, label);
      }
      break;
    }

    case "Int16Property":  r.readInt16(label);  break;
    case "UInt16Property": r.readUint16(label); break;
    case "IntProperty":    r.readInt32(label);  break;
    case "UInt32Property": r.readUint32(label); break;
    case "Int64Property":  r.readInt64(label);  break;
    case "UInt64Property": r.readUint64(label); break;

    // ── Floating-point ───────────────────────────────────────────────────────
    case "FloatProperty":  r.readFloat32(label); break;
    case "DoubleProperty": r.readFloat64(label); break;

    // ── String-like ──────────────────────────────────────────────────────────
    case "StrProperty":
      r.readFString(label); break;

    case "NameProperty":
      readFName(r, names, label); break;

    case "TextProperty":
      readTextAnnotation(r, label, valueEnd); break;

    // ── Object references ────────────────────────────────────────────────────
    case "ObjectProperty":
    case "ClassProperty":
    case "AssetObjectProperty":
    case "WeakObjectProperty":
    case "LazyObjectProperty":
      r.readInt32(label); // FPackageIndex
      break;

    case "SoftObjectProperty":
    case "SoftClassProperty":
      // FSoftObjectPath = FTopLevelAssetPath (PackageName + AssetName, each 2×int32) + FString SubPath
      r.group(label, () => {
        readFName(r, names, "Package Name");
        readFName(r, names, "Asset Name");
        r.readFString("Sub Path");
      });
      break;

    // ── Struct ───────────────────────────────────────────────────────────────
    case "StructProperty": {
      const structName = propType.params[0]?.name ?? "";
      if (hasNative) {
        const nativeReader = NATIVE_STRUCT_READERS[structName];
        if (nativeReader) {
          r.group(label, () => nativeReader(r));
        } else {
          // Unknown native struct — raw bytes
          r.readBytes(valueEnd - r.pos, label);
        }
      } else {
        // Non-native struct: many of these use custom binary serialization even
        // without HasBinaryOrNativeSerialize, so read as raw bytes to be safe.
        r.readBytes(valueEnd - r.pos, label);
      }
      break;
    }

    // ── Array ────────────────────────────────────────────────────────────────
    case "ArrayProperty": {
      const innerType = propType.params[0] ?? { name: "UnknownProperty", params: [] };
      r.group(label, () => {
        const count = r.readInt32("Count");
        for (let i = 0; i < count && r.pos < valueEnd; i++) {
          readPropertyValue(r, names, innerType, hasNative, valueEnd, fileVersionUE5, `[${i}]`);
        }
        return `${count} element${count !== 1 ? "s" : ""}`;
      });
      break;
    }

    // ── Set ──────────────────────────────────────────────────────────────────
    case "SetProperty": {
      const innerType = propType.params[0] ?? { name: "UnknownProperty", params: [] };
      r.group(label, () => {
        const numRemove = r.readInt32("Keys To Remove");
        for (let i = 0; i < numRemove && r.pos < valueEnd; i++) {
          readPropertyValue(r, names, innerType, hasNative, valueEnd, fileVersionUE5, `[remove ${i}]`);
        }
        const count = r.readInt32("Count");
        for (let i = 0; i < count && r.pos < valueEnd; i++) {
          readPropertyValue(r, names, innerType, hasNative, valueEnd, fileVersionUE5, `[${i}]`);
        }
        return `${count} element${count !== 1 ? "s" : ""}`;
      });
      break;
    }

    // ── Map ──────────────────────────────────────────────────────────────────
    case "MapProperty": {
      const keyType = propType.params[0] ?? { name: "UnknownProperty", params: [] };
      const valType = propType.params[1] ?? { name: "UnknownProperty", params: [] };
      r.group(label, () => {
        const numRemove = r.readInt32("Keys To Remove");
        for (let i = 0; i < numRemove && r.pos < valueEnd; i++) {
          r.group(`[remove ${i}]`, () => {
            readPropertyValue(r, names, keyType, false, valueEnd, fileVersionUE5, "Key");
            readPropertyValue(r, names, valType, false, valueEnd, fileVersionUE5, "Value");
          });
        }
        const count = r.readInt32("Count");
        for (let i = 0; i < count && r.pos < valueEnd; i++) {
          r.group(`[${i}]`, () => {
            readPropertyValue(r, names, keyType, false, valueEnd, fileVersionUE5, "Key");
            readPropertyValue(r, names, valType, false, valueEnd, fileVersionUE5, "Value");
          });
        }
        return `${count} entr${count !== 1 ? "ies" : "y"}`;
      });
      break;
    }

    // ── Optional ─────────────────────────────────────────────────────────────
    case "OptionalProperty": {
      const innerType = propType.params[0] ?? { name: "UnknownProperty", params: [] };
      r.group(label, () => {
        const hasValue = r.readUint8("Has Value");
        if (hasValue) {
          readPropertyValue(r, names, innerType, hasNative, valueEnd, fileVersionUE5, "Value");
        }
      });
      break;
    }

    // ── Unknown / fallback ────────────────────────────────────────────────────
    default: {
      const remaining = valueEnd - r.pos;
      if (remaining > 0) r.readBytes(remaining, label);
      break;
    }
  }
}

// ── Main entry point ───────────────────────────────────────────────────────────

/**
 * Parse the tagged-property stream for one export's property region.
 *
 * The reader must be positioned at `absScriptStart` (start of the script region).
 *
 * @param r               Binary reader cursor at start of the property region.
 * @param names           Package name table (resolved strings).
 * @param endOffset       Absolute byte offset of the END of the property region.
 * @param fileVersionUE5  UE5 object version (e.g. 1018 for UE5.7.3).
 * @param isUClass        True for regular UObject instances (always true for exported objects).
 */
export function parseTaggedProperties(
  r: BinaryReader,
  names: string[],
  endOffset: number,
  fileVersionUE5: number,
  isUClass: boolean = true,
): void {
  const newFormat = fileVersionUE5 >= UE5_PROPERTY_TAG_COMPLETE_TYPE_NAME;

  // ── Preamble: SerializationControlExtension (UE5 >= 1011, UClass objects only) ──
  if (isUClass && fileVersionUE5 >= UE5_PROPERTY_TAG_EXTENSION_AND_OVERRIDABLE_SERIALIZATION) {
    r.group("Serialization Control Extensions", () => {
      const ctrlExt = r.readUint8("Control Extension Flags");
      r.setLastDisplay(flagsStr8(ctrlExt, EClassSerializationControlExtension));
      if (ctrlExt & CTRL_EXT_OVERRIDABLE_SERIALIZATION) {
        r.readUint8("Overridable Operation");
      }
    });
  }

  // ── Property tag loop ──────────────────────────────────────────────────────
  while (r.pos < endOffset) {
    const savedPos = r.pos;

    // Peek at the property name to detect the "None" terminator.
    const nameIdx = r.readInt32();
    r.readInt32(); // instance number
    const propName = names[nameIdx] ?? `<name#${nameIdx}>`;

    if (propName === "None") {
      // Annotate the 8-byte "None" FName terminator.
      r.seek(savedPos);
      r.readBytes(8, "None (Properties End)");
      break;
    }

    // Seek back and consume the whole tag as a group.
    r.seek(savedPos);

    if (newFormat) {
      r.group(propName, () => {
        r.readInt32("Name Index");
        r.readInt32(); // instance number

        // FPropertyTypeName: one or more 12-byte nodes, recursively.
        let propType: PropType = { name: "UnknownProperty", params: [] };
        r.group("Type", () => {
          propType = readTypeNameNode(r, names);
          return propTypeStr(propType);
        });

        const size  = r.readInt32("Size");
        const flags = r.readUint8("Flags");
        r.setLastDisplay(flagsStr8(flags, EPropertyTagFlags));

        if (flags & FLAG_HAS_ARRAY_INDEX)   r.readInt32("Array Index");
        if (flags & FLAG_HAS_PROPERTY_GUID) r.readFGuid("Property GUID");
        if (flags & FLAG_HAS_PROPERTY_EXTENSIONS) {
          r.group("Extensions", () => {
            const extFlags = r.readUint8("Extension Flags");
            r.setLastDisplay(flagsStr8(extFlags, EPropertyTagExtension));
            if (extFlags & EXT_OVERRIDABLE_INFO) {
              r.readUint8("Override Operation");
              r.readUint8("Experimental Override Logic");
            }
          });
        }

        // HasBinaryOrNativeSerialize (0x08): value bytes present, binary layout.
        // BoolTrue (0x10): value in flags; size == 0, nothing to read.
        // SkippedSerialize (0x20): bytes present but semantically skipped by loader.
        if (size > 0) {
          const hasNative = !!(flags & FLAG_HAS_BINARY_OR_NATIVE);
          const valueEnd = r.pos + size;
          readPropertyValue(r, names, propType, hasNative, valueEnd, fileVersionUE5, "Value");
          // Safety: consume any bytes the value parser left unconsumed.
          if (r.pos < valueEnd) r.readBytes(valueEnd - r.pos, "Remaining Value");
        }
      });
    } else {
      // Old format (pre-1012): separate FName fields for type.
      r.group(propName, () => {
        r.readInt32("Name Index");
        r.readInt32(); // instance number

        const typeIdx  = r.readInt32();
        r.readInt32(); // type instance number
        const typeName = names[typeIdx] ?? `<type#${typeIdx}>`;

        const size = r.readInt32("Size");
        r.readInt32("Array Index");

        // Type-specific header data in the old format.
        switch (typeName) {
          case "StructProperty":
            r.readInt32(); r.readInt32(); // struct name FName
            r.readFGuid();               // struct GUID
            break;
          case "BoolProperty":
            r.readUint8("Bool Value");
            break;
          case "ByteProperty":
          case "EnumProperty":
          case "ArrayProperty":
          case "OptionalProperty":
          case "SetProperty":
            r.readInt32(); r.readInt32(); // inner/enum type FName
            break;
          case "MapProperty":
            r.readInt32(); r.readInt32(); // key type FName
            r.readInt32(); r.readInt32(); // value type FName
            break;
          default:
            break;
        }

        const hasGuid = r.readUint8("Has Property GUID");
        if (hasGuid) r.readFGuid("Property GUID");

        if (size > 0) r.readBytes(size, `Value (${typeName})`);
      });
    }
  }

  // Annotate any remaining bytes in the script region (padding / native tail).
  if (r.pos < endOffset) {
    r.readBytes(endOffset - r.pos, "Remaining Script Data");
  }
}
