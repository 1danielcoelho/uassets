/**
 * FPropertyTag parsing for UE5 tagged-property format.
 *
 * References:
 *   ue_source_dump/PropertyTag.cpp      — tag wire format
 *   ue_source_dump/PropertyTypeName.cpp — FPropertyTypeName binary layout
 *
 * Wire format for UE5 >= PROPERTY_TAG_COMPLETE_TYPE_NAME (version 1012):
 *
 *   loop:
 *     FName name             (2 × int32: nameIndex, instanceNumber)
 *       → if resolves to "None", stop
 *     FPropertyTypeName type (N nodes × 12 bytes; N determined by InnerCount fields)
 *     int32 size             (value byte count, EXCLUDING tag header)
 *     uint8 flags            (EPropertyTagFlags bitmask)
 *       HasArrayIndex     0x01  → int32 arrayIndex
 *       HasPropertyGuid   0x02  → FGuid (16 bytes)
 *       HasPropertyExt    0x04  → uint8 extFlags; if OverridableInfo 0x02: +2 bytes
 *     [value: size bytes]
 *
 * Wire format for older packages (version < 1012):
 *   FName name, FName type, int32 size, int32 arrayIndex,
 *   type-specific header, uint8 hasPropertyGuid, [FGuid], [value]
 */

import { BinaryReader } from "./reader.ts";

// EPropertyTagFlags
const FLAG_HAS_ARRAY_INDEX   = 0x01;
const FLAG_HAS_PROPERTY_GUID = 0x02;
const FLAG_HAS_PROPERTY_EXT  = 0x04;

// EPropertyTagExtension
const EXT_OVERRIDABLE_INFO = 0x02;

// UE5 version where the new compact tag format was introduced
const UE5_PROPERTY_TAG_COMPLETE_TYPE_NAME = 1012;

/**
 * Read nodes of an FPropertyTypeName from the binary archive (no-label variant).
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
    r.readInt32(); // instance number (ignore)
    const ic = r.readInt32();
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
 * @param r           Binary reader, cursor at the start of the property region.
 * @param names       Package name table (resolved strings).
 * @param endOffset   Absolute byte offset of the end of the property region.
 * @param fileVersionUE5  UE5 object version (e.g. 1018 for UE5.7.3).
 */
export function parseTaggedProperties(
  r: BinaryReader,
  names: string[],
  endOffset: number,
  fileVersionUE5: number,
): void {
  const newFormat = fileVersionUE5 >= UE5_PROPERTY_TAG_COMPLETE_TYPE_NAME;

  while (r.pos < endOffset) {
    const savedPos = r.pos;

    // Peek at the property name to detect the "None" terminator.
    const nameIdx = r.readInt32();
    r.readInt32(); // instance number
    const propName = names[nameIdx] ?? `<name#${nameIdx}>`;

    if (propName === "None") {
      // Annotate the 8-byte terminator and exit.
      r.seek(savedPos);
      r.readBytes(8, "None (Properties End)");
      break;
    }

    // Seek back and consume the whole tag as a group.
    r.seek(savedPos);

    if (newFormat) {
      r.group(`Property: ${propName}`, () => {
        r.readInt32("Name Index");
        r.readInt32(); // instance number

        // FPropertyTypeName: one or more nodes until Remaining reaches 0.
        let typeName = "Unknown";
        r.group("Type", () => {
          typeName = readTypeName(r, names);
        });

        const size  = r.readInt32("Size");
        const flags = r.readUint8("Flags");

        if (flags & FLAG_HAS_ARRAY_INDEX)   r.readInt32("Array Index");
        if (flags & FLAG_HAS_PROPERTY_GUID) r.readFGuid("Property GUID");
        if (flags & FLAG_HAS_PROPERTY_EXT) {
          r.group("Extensions", () => {
            const extFlags = r.readUint8("Extension Flags");
            if (extFlags & EXT_OVERRIDABLE_INFO) {
              r.readUint8("Override Operation");
              r.readUint8("Experimental Override Logic");
            }
          });
        }

        if (size > 0) r.readBytes(size, `Value (${typeName})`);
      });
    } else {
      // Old format (pre-1012): separate FName fields for type + inline header data.
      r.group(`Property: ${propName}`, () => {
        r.readInt32("Name Index");
        r.readInt32(); // instance number

        const typeIdx  = r.readInt32();
        r.readInt32(); // type instance number
        const typeName = names[typeIdx] ?? `<type#${typeIdx}>`;

        const size = r.readInt32("Size");
        r.readInt32("Array Index");

        // Type-specific tag header (old format).
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

  // Annotate any remaining bytes after the "None" terminator (padding / native tail).
  if (r.pos < endOffset) {
    r.readBytes(endOffset - r.pos, "Remaining Export Data");
  }
}
