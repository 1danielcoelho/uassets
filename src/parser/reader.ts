import type { ByteRange } from "../types.ts";
import type {
  FGuid,
  FEngineVersion,
  FCustomVersion,
  FGenerationInfo,
  FCompressedChunk,
} from "./types.ts";

/**
 * Cursor-based binary reader over an ArrayBuffer.
 *
 * All multi-byte integers are read as little-endian (UE default).
 *
 * Every read method accepts an optional `label`. When a label is supplied the
 * method pushes a typed ByteRange to the internal annotation list in addition
 * to returning the value. Omit the label for internal/intermediate reads that
 * don't need their own annotation (e.g. inside a `group()` lambda).
 *
 * Use `group(label, fn)` to wrap a block of reads under a single parent
 * annotation whose children are all the labeled reads performed inside `fn`.
 */
const utf8Decoder  = new TextDecoder("utf-8");
const utf16Decoder = new TextDecoder("utf-16le");

export class BinaryReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private readonly _annotations: ByteRange[] = [];

  /** Current read cursor position (byte offset). */
  pos: number = 0;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
  }

  get byteLength(): number {
    return this.view.byteLength;
  }

  /** Throw a descriptive error if reading `n` bytes at the current position would exceed the buffer. */
  private assertBounds(n: number, context?: string): void {
    if (this.pos + n > this.view.byteLength) {
      const ctx = context ? ` (reading "${context}")` : "";
      throw new RangeError(
        `Out of bounds${ctx}: tried to read ${n} bytes at offset 0x${this.pos.toString(16).toUpperCase()}, ` +
        `but file is only ${this.view.byteLength} bytes (0x${this.view.byteLength.toString(16).toUpperCase()})`,
      );
    }
  }

  // ── Raw scalar reads ───────────────────────────────────────────────────────

  readUint8(): number;
  readUint8(label: string): number;
  readUint8(label?: string): number {
    const start = this.pos;
    this.assertBounds(1, label);
    const value = this.view.getUint8(this.pos);
    this.pos += 1;
    if (label !== undefined) this._annotations.push({ kind: "uint8", start, end: this.pos, label, value });
    return value;
  }

  readInt16(): number;
  readInt16(label: string): number;
  readInt16(label?: string): number {
    const start = this.pos;
    this.assertBounds(2, label);
    const value = this.view.getInt16(this.pos, true);
    this.pos += 2;
    if (label !== undefined) this._annotations.push({ kind: "int16", start, end: this.pos, label, value });
    return value;
  }

  readUint16(): number;
  readUint16(label: string): number;
  readUint16(label?: string): number {
    const start = this.pos;
    this.assertBounds(2, label);
    const value = this.view.getUint16(this.pos, true);
    this.pos += 2;
    if (label !== undefined) this._annotations.push({ kind: "uint16", start, end: this.pos, label, value });
    return value;
  }

  readInt32(): number;
  readInt32(label: string): number;
  readInt32(label?: string): number {
    const start = this.pos;
    this.assertBounds(4, label);
    const value = this.view.getInt32(this.pos, true);
    this.pos += 4;
    if (label !== undefined) this._annotations.push({ kind: "int32", start, end: this.pos, label, value });
    return value;
  }

  readUint32(): number;
  readUint32(label: string): number;
  readUint32(label?: string): number {
    const start = this.pos;
    this.assertBounds(4, label);
    const value = this.view.getUint32(this.pos, true);
    this.pos += 4;
    if (label !== undefined) this._annotations.push({ kind: "uint32", start, end: this.pos, label, value });
    return value;
  }

  readUint32BE(): number;
  readUint32BE(label: string): number;
  readUint32BE(label?: string): number {
    const start = this.pos;
    this.assertBounds(4, label);
    const value = this.view.getUint32(this.pos, false);
    this.pos += 4;
    if (label !== undefined) this._annotations.push({ kind: "uint32", start, end: this.pos, label, value });
    return value;
  }

  readUint64BE(): bigint;
  readUint64BE(label: string): bigint;
  readUint64BE(label?: string): bigint {
    const start = this.pos;
    this.assertBounds(8, label);
    const value = this.view.getBigUint64(this.pos, false);
    this.pos += 8;
    if (label !== undefined) this._annotations.push({ kind: "uint64", start, end: this.pos, label, value });
    return value;
  }

  readInt64(): bigint;
  readInt64(label: string): bigint;
  readInt64(label?: string): bigint {
    const start = this.pos;
    this.assertBounds(8, label);
    const value = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    if (label !== undefined) this._annotations.push({ kind: "int64", start, end: this.pos, label, value });
    return value;
  }

  readUint64(): bigint;
  readUint64(label: string): bigint;
  readUint64(label?: string): bigint {
    const start = this.pos;
    this.assertBounds(8, label);
    const value = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    if (label !== undefined) this._annotations.push({ kind: "uint64", start, end: this.pos, label, value });
    return value;
  }

  readFloat32(): number;
  readFloat32(label: string): number;
  readFloat32(label?: string): number {
    const start = this.pos;
    this.assertBounds(4, label);
    const value = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    if (label !== undefined) this._annotations.push({ kind: "float32", start, end: this.pos, label, value });
    return value;
  }

  readFloat64(): number;
  readFloat64(label: string): number;
  readFloat64(label?: string): number {
    const start = this.pos;
    this.assertBounds(8, label);
    const value = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    if (label !== undefined) this._annotations.push({ kind: "float64", start, end: this.pos, label, value });
    return value;
  }

  readBytes(n: number): Uint8Array;
  readBytes(n: number, label: string): Uint8Array;
  readBytes(n: number, label?: string): Uint8Array {
    const start = this.pos;
    this.assertBounds(n, label);
    const value = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    if (label !== undefined) this._annotations.push({ kind: "bytes", start, end: this.pos, label, value });
    return value;
  }

  /** Read bytes at an absolute offset without moving the cursor. */
  peekBytesAt(offset: number, n: number): Uint8Array {
    return this.bytes.slice(offset, offset + n);
  }

  /** Move cursor to an absolute position. */
  seek(offset: number): void {
    this.pos = offset;
  }

  // ── UE primitive reads ─────────────────────────────────────────────────────

  readFString(): string;
  readFString(label: string): string;
  readFString(label?: string): string {
    const start = this.pos;
    const len = this.readInt32();
    let value: string;
    if (len === 0) {
      value = "";
    } else if (len > 0) {
      const bytes = this.readBytes(len);
      const end = bytes[len - 1] === 0 ? len - 1 : len;
      value = utf8Decoder.decode(bytes.subarray(0, end));
    } else {
      const charCount = -len;
      const bytes = this.readBytes(charCount * 2);
      const end = (bytes[charCount * 2 - 1] === 0 && bytes[charCount * 2 - 2] === 0)
        ? (charCount - 1) * 2
        : charCount * 2;
      value = utf16Decoder.decode(bytes.subarray(0, end));
    }
    if (label !== undefined) this._annotations.push({ kind: "string", start, end: this.pos, label, value });
    return value;
  }

  readFGuid(): FGuid;
  readFGuid(label: string): FGuid;
  readFGuid(label?: string): FGuid {
    const start = this.pos;
    const value: FGuid = {
      a: this.readUint32(),
      b: this.readUint32(),
      c: this.readUint32(),
      d: this.readUint32(),
    };
    if (label !== undefined) this._annotations.push({ kind: "guid", start, end: this.pos, label, value });
    return value;
  }

  readFEngineVersion(): FEngineVersion {
    return {
      major:      this.readUint16("Major"),
      minor:      this.readUint16("Minor"),
      patch:      this.readUint16("Patch"),
      changelist: this.readUint32("Changelist"),
      branch:     this.readFString("Branch"),
    };
  }

  readFCustomVersion(): FCustomVersion {
    return { guid: this.readFGuid(), version: this.readInt32() };
  }

  readFGenerationInfo(): FGenerationInfo {
    return { exportCount: this.readInt32(), nameCount: this.readInt32() };
  }

  readFCompressedChunk(): FCompressedChunk {
    return {
      uncompressedOffset: this.readInt32(),
      uncompressedSize:   this.readInt32(),
      compressedOffset:   this.readInt32(),
      compressedSize:     this.readInt32(),
    };
  }

  readArray<T>(readItem: (r: BinaryReader) => T): T[] {
    const count = this.readInt32();
    const result: T[] = [];
    for (let i = 0; i < count; i++) {
      result.push(readItem(this));
    }
    return result;
  }

  // ── Annotation grouping ────────────────────────────────────────────────────

  /**
   * Runs `fn`, collects all labeled reads performed inside it as children, and
   * emits a single "group" ByteRange covering the whole span.
   *
   * Returns the value produced by `fn`.
   */
  group<T>(label: string, fn: () => T): T {
    const before = this._annotations.length;
    const start = this.pos;
    const value = fn();
    const end = this.pos;
    const children: ByteRange[] = this._annotations.splice(before);
    this._annotations.push({ kind: "group", start, end, label, value, children });
    return value;
  }

  /** Return all top-level collected annotations in order. */
  getAnnotations(): ByteRange[] {
    return this._annotations;
  }
}
