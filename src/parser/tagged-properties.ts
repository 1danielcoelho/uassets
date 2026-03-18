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
import { flagsStr8, enumStr, EPropertyTagFlags, EPropertyTagExtension, EClassSerializationControlExtension } from "./enums.ts";

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

/**
 * Read nodes of an FPropertyTypeName from the binary archive (unlabeled).
 *
 * Each node: FName (2 × int32) + int32 InnerCount = 12 bytes.
 * The loop starts with Remaining = 1 and runs until Remaining reaches 0.
 * Returns the root (first node) type name string.
 */
function readTypeName(r: BinaryReader, names: string[]): string {
  let remaining = 1;
  let first = true;
  let rootName = "Unknown";
  while (remaining > 0) {
    const ni = r.readInt32();
    r.readInt32(); // instance number
    const ic = r.readInt32(); // InnerCount
    if (first) {
      rootName = names[ni] ?? `<name#${ni}>`;
      first = false;
    }
    remaining += ic - 1;
  }
  return rootName;
}

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

        // FPropertyTypeName: one or more nodes until Remaining reaches 0.
        let typeName = "Unknown";
        r.group("Type", () => {
          typeName = readTypeName(r, names);
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
        // HasBinaryOrNativeSerialize (0x08): value bytes still present.
        // BoolTrue (0x10): bool value is in flags, size == 0, no value bytes.
        // SkippedSerialize (0x20): size bytes present, just gets skipped by loader.
        if (size > 0) r.readBytes(size, `Value (${typeName})`);
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
