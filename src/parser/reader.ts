import type { ByteRange, ColorKey } from "../types.ts";

/**
 * Cursor-based binary reader over an ArrayBuffer.
 *
 * All multi-byte integers are read as little-endian (UE default).
 *
 * The `annotate()` method wraps a read callback and records the byte range it
 * consumed along with a label and color, building up the annotation tree that
 * the hex viewer renders.
 */
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

  // ── Raw reads ─────────────────────────────────────────────────────────────

  readUint8(): number {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  readInt16(): number {
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readUint16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readInt32(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readUint32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readInt64(): bigint {
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }

  readUint64(): bigint {
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }

  readFloat32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readFloat64(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  readBytes(n: number): Uint8Array {
    const slice = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  /** Read bytes at an absolute offset without moving the cursor. */
  peekBytesAt(offset: number, n: number): Uint8Array {
    return this.bytes.slice(offset, offset + n);
  }

  /** Move cursor to an absolute position. */
  seek(offset: number): void {
    this.pos = offset;
  }

  // ── Annotation ────────────────────────────────────────────────────────────

  /**
   * Wraps a read callback, recording the byte range consumed as an annotation.
   *
   * Returns the value produced by `fn`. The annotation is added to the internal
   * list AND returned as the second element of a tuple so callers can nest
   * annotations as children.
   *
   * Example:
   *   const [ver, range] = reader.annotate("Engine Version", "version", () => reader.readFEngineVersion());
   */
  annotate<T>(
    label: string,
    color: ColorKey,
    fn: () => T,
    valueToString?: (v: T) => string,
    children?: ByteRange[],
  ): [T, ByteRange] {
    const start = this.pos;
    const value = fn();
    const end = this.pos;
    const range: ByteRange = {
      start,
      end,
      label,
      color,
      value: valueToString ? valueToString(value) : stringifyValue(value),
      children,
    };
    this._annotations.push(range);
    return [value, range];
  }

  /**
   * Like `annotate`, but collects child annotations produced inside `fn` and
   * attaches them as `children` on the parent range.
   *
   * The child annotations are NOT added to the top-level list — only the
   * parent is. Children are accessible via `range.children`.
   */
  annotateGroup<T>(
    label: string,
    color: ColorKey,
    fn: () => T,
    valueToString?: (v: T) => string,
  ): [T, ByteRange] {
    const before = this._annotations.length;
    const start = this.pos;
    const value = fn();
    const end = this.pos;
    // Pull out any annotations added during fn() — they become children
    const children = this._annotations.splice(before);
    const range: ByteRange = {
      start,
      end,
      label,
      color,
      value: valueToString ? valueToString(value) : stringifyValue(value),
      children: children.length > 0 ? children : undefined,
    };
    this._annotations.push(range);
    return [value, range];
  }

  /** Return all top-level collected annotations in order. */
  getAnnotations(): ByteRange[] {
    return this._annotations;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return v.toString();
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v.toString();
  if (Array.isArray(v)) return `[${v.length} items]`;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
