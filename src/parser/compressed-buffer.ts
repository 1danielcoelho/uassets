/**
 * FCompressedBuffer parser.
 *
 * FCompressedBuffer is the format used to store compressed payloads in
 * PackageTrailer entries (and elsewhere in UE5). The header is always 64 bytes,
 * stored in big-endian byte order.
 *
 * Source: Engine/Source/Runtime/Core/Private/Compression/CompressedBuffer.cpp
 */

import type { BinaryReader } from "./reader.ts";
import { enumStr, ECompressedBufferMethod } from "./enums.ts";

const COMPRESSED_BUFFER_MAGIC = 0xb7756362; // ".ucb"

/** EMethod values from CompressedBuffer.cpp (EMethod enum, line 37) */
const METHOD_NONE  = 0;
const METHOD_OODLE = 3;
const METHOD_LZ4   = 4;

/**
 * Parse a FCompressedBuffer payload in-place.
 *
 * Reads and annotates the 64-byte big-endian FHeader, followed by:
 *   - Method=Oodle: BlockCount×uint32 compressed block sizes + compressed blocks
 *   - Method=None:  raw uncompressed data
 *   - Unknown:      remaining bytes as opaque
 *
 * @param r                  BinaryReader positioned at the start of the payload
 * @param totalCompressedSize  Total byte size of this payload (from the lookup entry)
 * @param label              Group label for this payload
 */
export function readCompressedBuffer(
  r: BinaryReader,
  totalCompressedSize: number,
  label: string,
): void {
  const payloadStart = r.pos;
  r.group(label, () => {
    if (totalCompressedSize < 64) {
      // Too small to hold even the header — read as opaque
      r.readBytes(totalCompressedSize, "Data (too small for FCompressedBuffer header)");
      return;
    }

    // ── 64-byte FHeader (big-endian) ─────────────────────────────────────────
    const magic = r.readUint32BE("Magic");
    r.readUint32BE("Crc32");
    const method          = r.readUint8("Method");
    r.setLastDisplay(enumStr(method, ECompressedBufferMethod));
    r.readUint8("Compressor");
    r.readUint8("CompressionLevel");
    r.readUint8("BlockSizeExponent");
    const blockCount      = r.readUint32BE("BlockCount");
    const totalRawSize    = r.readUint64BE("TotalRawSize");
    r.readUint64BE("TotalCompressedSize");
    r.readBytes(32, "RawHash (Blake3)");
    // Header is now fully consumed (64 bytes)

    if (magic !== COMPRESSED_BUFFER_MAGIC) {
      // Not a valid FCompressedBuffer — read remainder as opaque
      const remaining = totalCompressedSize - (r.pos - payloadStart);
      if (remaining > 0) r.readBytes(remaining, "Data (unexpected magic, opaque)");
      return;
    }

    if (method === METHOD_OODLE || method === METHOD_LZ4) {
      // BlockCount × uint32 compressed block sizes (big-endian), then compressed blocks
      const codec = method === METHOD_OODLE ? "Oodle" : "LZ4";
      const blockSizes: number[] = [];
      r.group("Block Sizes", () => {
        for (let i = 0; i < blockCount; i++) {
          blockSizes.push(r.readUint32BE(`Block[${i}] Compressed Size`));
        }
      });
      for (let i = 0; i < blockSizes.length; i++) {
        r.readBytes(blockSizes[i]!, `Block[${i}] (${codec} compressed)`);
      }
    } else if (method === METHOD_NONE) {
      // Uncompressed — raw data follows directly
      r.readBytes(Number(totalRawSize), "Uncompressed Data");
    } else {
      // Unknown method — read remainder as opaque
      const remaining = totalCompressedSize - (r.pos - payloadStart);
      if (remaining > 0) r.readBytes(remaining, `Data (unknown method ${method}, opaque)`);
    }
  });
}
