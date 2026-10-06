import { compareBytes } from "../bytes.js";
/**
 * Deterministic, lossless encoding for legacy structured-clone values.
 *
 * The byte layout is the `canonical-clone-cbor-v1` contract documented in
 * `docs/architecture/relay-storage-summary-zh.md`. This is intentionally not
 * a general-purpose CBOR implementation: accepting another CBOR spelling or
 * another application tag would make record digests non-portable.
 */

import { sha256Hex } from "../hex.js";

export const CANONICAL_CLONE_CBOR_V1_ENCODING = "canonical-clone-cbor-v1" as const;

/**
 * Normative application-tag registry shared by Hub, Browser, and CLI codecs.
 *
 * These numbers are wire format, not implementation details. A new logical
 * value must use a new codec version rather than changing this registry.
 */
export const CANONICAL_CLONE_CBOR_V1_APPLICATION_TAGS = Object.freeze({
  undefined: 60_000,
  hole: 60_001,
  number: 60_002,
  bigint: 60_003,
  date: 60_004,
  arrayBuffer: 60_005,
  arrayBufferView: 60_006,
  object: 60_007,
  fieldPresence: 60_008,
  array: 60_009,
  logicalRecord: 60_010,
  cloneString: 60_011,
} as const);

const APPLICATION_TAG = CANONICAL_CLONE_CBOR_V1_APPLICATION_TAGS;

const MAX_UINT32 = 0xffff_ffff;
const MAX_ARRAY_LENGTH = 0xffff_ffff;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const UTF8 = new TextEncoder();
const DIGEST_PREFIX = UTF8.encode(`${CANONICAL_CLONE_CBOR_V1_ENCODING}\0`);

export type CanonicalCloneFieldPresenceState = 0 | 1 | 2;
export type CanonicalCloneFieldPresenceEntry = readonly [
  fieldId: number,
  state: CanonicalCloneFieldPresenceState,
];
export type CanonicalCloneLogicalRecordEntry = readonly [fieldId: number, value: unknown];

export type CanonicalCloneCborV1ErrorCode =
  | "invalid-field-presence"
  | "invalid-logical-record"
  | "malformed-cbor"
  | "shared-identity"
  | "unsupported-object"
  | "unsupported-type";

export class CanonicalCloneCborV1Error extends Error {
  readonly code: CanonicalCloneCborV1ErrorCode;

  constructor(code: CanonicalCloneCborV1ErrorCode, message: string) {
    super(message);
    this.name = "CanonicalCloneCborV1Error";
    this.code = code;
  }
}

/** Explicit tag-60008 value for a descriptor's stable field-id registry. */
export class CanonicalCloneFieldPresence {
  readonly entries: readonly CanonicalCloneFieldPresenceEntry[];

  constructor(entries: Iterable<CanonicalCloneFieldPresenceEntry>) {
    const normalized = [...entries]
      .map(([fieldId, state]) => {
        assertFieldId(fieldId, "field presence");
        if (state !== 0 && state !== 1 && state !== 2) {
          fail("invalid-field-presence", `field ${fieldId} has invalid presence state`);
        }
        return Object.freeze([fieldId, state] as const);
      })
      .sort(([left], [right]) => left - right);
    for (let index = 1; index < normalized.length; index += 1) {
      if (normalized[index - 1]![0] === normalized[index]![0]) {
        fail("invalid-field-presence", `field ${normalized[index]![0]} is duplicated`);
      }
    }
    this.entries = Object.freeze(normalized);
    Object.freeze(this);
  }
}

/** Explicit tag-60010 value. Exactly one direct field must be tag 60008. */
export class CanonicalCloneLogicalRecord {
  readonly entries: readonly CanonicalCloneLogicalRecordEntry[];

  constructor(entries: Iterable<CanonicalCloneLogicalRecordEntry>) {
    const normalized = [...entries]
      .map(([fieldId, value]) => {
        assertFieldId(fieldId, "logical record");
        return Object.freeze([fieldId, value] as const);
      })
      .sort(([left], [right]) => left - right);
    let presenceCount = 0;
    for (let index = 0; index < normalized.length; index += 1) {
      const [fieldId, value] = normalized[index]!;
      if (index > 0 && normalized[index - 1]![0] === fieldId) {
        fail("invalid-logical-record", `field ${fieldId} is duplicated`);
      }
      if (value instanceof CanonicalCloneFieldPresence) presenceCount += 1;
    }
    if (presenceCount !== 1) {
      fail("invalid-logical-record", "logical record must contain exactly one field-presence value");
    }
    this.entries = Object.freeze(normalized);
    Object.freeze(this);
  }
}

export function canonicalCloneFieldPresence(
  entries: Iterable<CanonicalCloneFieldPresenceEntry>,
): CanonicalCloneFieldPresence {
  return new CanonicalCloneFieldPresence(entries);
}

export function canonicalCloneLogicalRecord(
  entries: Iterable<CanonicalCloneLogicalRecordEntry>,
): CanonicalCloneLogicalRecord {
  return new CanonicalCloneLogicalRecord(entries);
}

/** Encode one complete logical value. The returned bytes are newly owned. */
export function encodeCanonicalCloneCborV1(value: unknown): Uint8Array {
  validateTree(value, new WeakSet<object>(), "$", false);
  const writer = new CborWriter();
  encodeLogicalValue(writer, value);
  return writer.finish();
}

/** Decode and validate one complete canonical-clone-cbor-v1 value. */
export function decodeCanonicalCloneCborV1(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array)) {
    fail("malformed-cbor", "encoded value must be a Uint8Array");
  }
  const reader = new CborReader(bytes);
  const value = decodeLogicalValue(reader, false);
  if (!reader.done) fail("malformed-cbor", "trailing bytes after logical value");
  return value;
}

/** SHA-256(codec id || 0x00 || canonical logical bytes), as lowercase hex. */
export async function digestCanonicalCloneCborV1(value: unknown): Promise<string> {
  return sha256CanonicalBytes(encodeCanonicalCloneCborV1(value));
}

/** Validate and digest already-encoded logical bytes using the v1 domain separator. */
export async function digestCanonicalCloneCborV1Bytes(bytes: Uint8Array): Promise<string> {
  if (!(bytes instanceof Uint8Array)) {
    fail("malformed-cbor", "encoded value must be a Uint8Array");
  }
  decodeCanonicalCloneCborV1(bytes);
  return sha256CanonicalBytes(bytes);
}

async function sha256CanonicalBytes(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(DIGEST_PREFIX.length + bytes.length);
  input.set(DIGEST_PREFIX);
  input.set(bytes, DIGEST_PREFIX.length);
  return sha256Hex(input);
}

function fail(code: CanonicalCloneCborV1ErrorCode, message: string): never {
  throw new CanonicalCloneCborV1Error(code, message);
}

function assertFieldId(value: number, owner: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UINT32) {
    fail(owner === "field presence" ? "invalid-field-presence" : "invalid-logical-record", `${owner} field id must be uint32`);
  }
}

function claimIdentity(value: object, seen: WeakSet<object>, path: string): void {
  if (seen.has(value)) {
    fail("shared-identity", `${path} repeats an object, array, view, or backing-buffer identity`);
  }
  seen.add(value);
}

function validateTree(value: unknown, seen: WeakSet<object>, path: string, claimed: boolean): void {
  if (
    value === null
    || value === undefined
    || typeof value === "boolean"
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "bigint"
  ) {
    return;
  }
  if (typeof value === "symbol" || typeof value === "function") {
    fail("unsupported-type", `${path} contains unsupported ${typeof value}`);
  }
  if (typeof value !== "object") {
    fail("unsupported-type", `${path} contains unsupported ${typeof value}`);
  }

  if (!claimed) claimIdentity(value, seen, path);

  if (value instanceof CanonicalCloneFieldPresence) {
    if (Object.getPrototypeOf(value) !== CanonicalCloneFieldPresence.prototype) {
      fail("unsupported-object", `${path} uses a field-presence subclass`);
    }
    return;
  }
  if (value instanceof CanonicalCloneLogicalRecord) {
    if (Object.getPrototypeOf(value) !== CanonicalCloneLogicalRecord.prototype) {
      fail("unsupported-object", `${path} uses a logical-record subclass`);
    }
    for (const [fieldId, fieldValue] of value.entries) {
      validateTree(fieldValue, seen, `${path}.field(${fieldId})`, false);
    }
    return;
  }
  if (value instanceof Date) {
    if (Object.getPrototypeOf(value) !== Date.prototype) {
      fail("unsupported-object", `${path} uses a Date subclass`);
    }
    return;
  }
  if (value instanceof ArrayBuffer) {
    validateArrayBuffer(value, path);
    return;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    assertSupportedView(view, path);
    const backing = view.buffer;
    if (!(backing instanceof ArrayBuffer)) {
      fail("unsupported-object", `${path} has a non-ArrayBuffer backing store`);
    }
    claimIdentity(backing, seen, `${path}.buffer`);
    validateArrayBuffer(backing, `${path}.buffer`);
    return;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      fail("unsupported-object", `${path} uses a non-standard array prototype`);
    }
    const descriptors = getArrayElementDescriptors(value, path);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors.get(index);
      if (descriptor) validateTree(descriptor.value, seen, `${path}[${index}]`, false);
    }
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("unsupported-object", `${path} is not a plain or null-prototype object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") fail("unsupported-type", `${path} contains a symbol key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) fail("unsupported-object", `${path}.${key} is an accessor`);
    if (!descriptor.enumerable) {
      fail("unsupported-object", `${path}.${key} is non-enumerable and has no v1 representation`);
    }
    validateTree(descriptor.value, seen, `${path}.${key}`, false);
  }
}

function validateArrayBuffer(buffer: ArrayBuffer, path: string): void {
  if (Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) {
    fail("unsupported-object", `${path} uses an ArrayBuffer subclass`);
  }
  if ((buffer as ArrayBuffer & { resizable?: boolean }).resizable === true) {
    fail("unsupported-object", `${path} is resizable and has no v1 representation`);
  }
  try {
    void buffer.byteLength;
    void new Uint8Array(buffer);
  } catch {
    fail("unsupported-object", `${path} is a detached ArrayBuffer`);
  }
}

type DataDescriptor = PropertyDescriptor & { value: unknown };

function getArrayElementDescriptors(value: unknown[], path: string): Map<number, DataDescriptor> {
  const descriptors = new Map<number, DataDescriptor>();
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key === "symbol") fail("unsupported-type", `${path} contains a symbol key`);
    const index = arrayIndex(key);
    if (index === null || index >= value.length) {
      fail("unsupported-object", `${path} contains non-index array property ${JSON.stringify(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) fail("unsupported-object", `${path}[${index}] is an accessor`);
    if (!descriptor.enumerable) {
      fail("unsupported-object", `${path}[${index}] is non-enumerable and has no v1 representation`);
    }
    descriptors.set(index, descriptor as DataDescriptor);
  }
  return descriptors;
}

function arrayIndex(key: string): number | null {
  if (key === "" || key === "-0") return null;
  const parsed = Number(key);
  return Number.isInteger(parsed) && parsed >= 0 && parsed < MAX_ARRAY_LENGTH && String(parsed) === key
    ? parsed
    : null;
}

const VIEW_TYPES = [
  DataView,
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
] as const;

function viewSubtype(value: ArrayBufferView): number {
  const prototype = Object.getPrototypeOf(value);
  const subtype = VIEW_TYPES.findIndex((constructor) => prototype === constructor.prototype);
  if (subtype < 0) fail("unsupported-object", "unsupported TypedArray/DataView subtype or subclass");
  return subtype;
}

function assertSupportedView(value: ArrayBufferView, path: string): void {
  try {
    viewSubtype(value);
    void value.byteOffset;
    void value.byteLength;
  } catch (error) {
    if (error instanceof CanonicalCloneCborV1Error) throw error;
    fail("unsupported-object", `${path} is a detached or invalid ArrayBuffer view`);
  }
}

function viewLogicalLength(value: ArrayBufferView, subtype: number): number {
  return subtype === 0 ? value.byteLength : (value as ArrayBufferView & { readonly length: number }).length;
}

class CborWriter {
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  writeRaw(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  writeInitial(major: number, value: number | bigint): void {
    const argument = typeof value === "bigint" ? value : BigInt(value);
    if (argument < 0n || argument > 0xffff_ffff_ffff_ffffn) {
      fail("unsupported-object", "CBOR argument is outside uint64");
    }
    if (argument < 24n) {
      this.writeRaw(Uint8Array.of((major << 5) | Number(argument)));
      return;
    }
    if (argument <= 0xffn) {
      this.writeRaw(Uint8Array.of((major << 5) | 24, Number(argument)));
      return;
    }
    const byteLength = argument <= 0xffffn ? 2 : argument <= 0xffff_ffffn ? 4 : 8;
    const header = new Uint8Array(1 + byteLength);
    header[0] = (major << 5) | (byteLength === 2 ? 25 : byteLength === 4 ? 26 : 27);
    let remaining = argument;
    for (let index = byteLength; index > 0; index -= 1) {
      header[index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    this.writeRaw(header);
  }

  writeUnsigned(value: number | bigint): void {
    this.writeInitial(0, value);
  }

  writeSigned(value: number): void {
    if (!Number.isSafeInteger(value)) fail("unsupported-object", "native CBOR integer is not safe");
    if (value >= 0) this.writeInitial(0, value);
    else this.writeInitial(1, BigInt(-1 - value));
  }

  writeTag(tag: number): void {
    this.writeInitial(6, tag);
  }

  writeArrayHeader(length: number): void {
    this.writeInitial(4, length);
  }

  writeBytes(bytes: Uint8Array): void {
    this.writeInitial(2, bytes.length);
    this.writeRaw(bytes);
  }

  finish(): Uint8Array {
    const bytes = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
}

function encodeLogicalValue(writer: CborWriter, value: unknown): void {
  if (value === null) {
    writer.writeRaw(Uint8Array.of(0xf6));
  } else if (value === false) {
    writer.writeRaw(Uint8Array.of(0xf4));
  } else if (value === true) {
    writer.writeRaw(Uint8Array.of(0xf5));
  } else if (value === undefined) {
    writeEmptyTaggedBytes(writer, APPLICATION_TAG.undefined);
  } else if (typeof value === "number") {
    writer.writeTag(APPLICATION_TAG.number);
    writer.writeBytes(encodeNumber(value));
  } else if (typeof value === "bigint") {
    encodeBigInt(writer, value);
  } else if (typeof value === "string") {
    encodeCloneString(writer, value);
  } else if (value instanceof CanonicalCloneFieldPresence) {
    encodeFieldPresence(writer, value);
  } else if (value instanceof CanonicalCloneLogicalRecord) {
    encodeLogicalRecord(writer, value);
  } else if (value instanceof Date) {
    encodeDate(writer, value);
  } else if (value instanceof ArrayBuffer) {
    writer.writeTag(APPLICATION_TAG.arrayBuffer);
    writer.writeBytes(new Uint8Array(value));
  } else if (ArrayBuffer.isView(value)) {
    encodeView(writer, value);
  } else if (Array.isArray(value)) {
    encodeArray(writer, value);
  } else {
    encodeObject(writer, value as Record<string, unknown>);
  }
}

function writeEmptyTaggedBytes(writer: CborWriter, tag: number): void {
  writer.writeTag(tag);
  writer.writeBytes(new Uint8Array());
}

function encodeNumber(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  if (Number.isNaN(value)) {
    bytes.set([0x7f, 0xf8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  } else {
    new DataView(bytes.buffer).setFloat64(0, value, false);
  }
  return bytes;
}

function encodeBigInt(writer: CborWriter, value: bigint): void {
  writer.writeTag(APPLICATION_TAG.bigint);
  writer.writeArrayHeader(2);
  const negative = value < 0n;
  writer.writeUnsigned(negative ? 1 : 0);
  let magnitude = negative ? -value : value;
  const reversed: number[] = [];
  while (magnitude > 0n) {
    reversed.push(Number(magnitude & 0xffn));
    magnitude >>= 8n;
  }
  writer.writeBytes(Uint8Array.from(reversed.reverse()));
}

function encodeDate(writer: CborWriter, value: Date): void {
  writer.writeTag(APPLICATION_TAG.date);
  const epochMillis = Date.prototype.getTime.call(value);
  if (Number.isNaN(epochMillis)) {
    writer.writeArrayHeader(1);
    writer.writeRaw(Uint8Array.of(0xf4));
  } else {
    writer.writeArrayHeader(2);
    writer.writeRaw(Uint8Array.of(0xf5));
    writer.writeSigned(epochMillis);
  }
}

function encodeView(writer: CborWriter, value: ArrayBufferView): void {
  const subtype = viewSubtype(value);
  writer.writeTag(APPLICATION_TAG.arrayBufferView);
  writer.writeArrayHeader(4);
  writer.writeUnsigned(subtype);
  writer.writeUnsigned(value.byteOffset);
  writer.writeUnsigned(viewLogicalLength(value, subtype));
  writer.writeBytes(new Uint8Array(value.buffer));
}

function encodeArray(writer: CborWriter, value: unknown[]): void {
  const descriptors = getArrayElementDescriptors(value, "$array");
  writer.writeTag(APPLICATION_TAG.array);
  writer.writeArrayHeader(2);
  writer.writeUnsigned(value.length);
  writer.writeArrayHeader(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors.get(index);
    if (descriptor) encodeLogicalValue(writer, descriptor.value);
    else writeEmptyTaggedBytes(writer, APPLICATION_TAG.hole);
  }
}

function encodeObject(writer: CborWriter, value: Record<string, unknown>): void {
  const entries = Object.keys(value).map((key) => ({
    key,
    keyBytes: encodeCloneStringBytes(key),
    value: Object.getOwnPropertyDescriptor(value, key)!.value,
  }));
  entries.sort((left, right) => compareBytes(left.keyBytes, right.keyBytes));
  writer.writeTag(APPLICATION_TAG.object);
  writer.writeArrayHeader(2);
  writer.writeUnsigned(Object.getPrototypeOf(value) === null ? 1 : 0);
  writer.writeArrayHeader(entries.length);
  for (const entry of entries) {
    writer.writeArrayHeader(2);
    writer.writeTag(APPLICATION_TAG.cloneString);
    writer.writeBytes(entry.keyBytes);
    encodeLogicalValue(writer, entry.value);
  }
}

function encodeFieldPresence(writer: CborWriter, value: CanonicalCloneFieldPresence): void {
  writer.writeTag(APPLICATION_TAG.fieldPresence);
  writer.writeArrayHeader(value.entries.length);
  for (const [fieldId, state] of value.entries) {
    writer.writeArrayHeader(2);
    writer.writeUnsigned(fieldId);
    writer.writeUnsigned(state);
  }
}

function encodeLogicalRecord(writer: CborWriter, value: CanonicalCloneLogicalRecord): void {
  writer.writeTag(APPLICATION_TAG.logicalRecord);
  writer.writeArrayHeader(value.entries.length);
  for (const [fieldId, fieldValue] of value.entries) {
    writer.writeArrayHeader(2);
    writer.writeUnsigned(fieldId);
    encodeLogicalValue(writer, fieldValue);
  }
}

function encodeCloneString(writer: CborWriter, value: string): void {
  writer.writeTag(APPLICATION_TAG.cloneString);
  writer.writeBytes(encodeCloneStringBytes(value));
}

function encodeCloneStringBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    bytes[index * 2] = codeUnit >>> 8;
    bytes[index * 2 + 1] = codeUnit & 0xff;
  }
  return bytes;
}

class CborReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset === this.bytes.length;
  }

  peekMajor(): number {
    if (this.offset >= this.bytes.length) fail("malformed-cbor", "unexpected end of CBOR input");
    return this.bytes[this.offset]! >>> 5;
  }

  private readByte(): number {
    if (this.offset >= this.bytes.length) fail("malformed-cbor", "unexpected end of CBOR input");
    return this.bytes[this.offset++]!;
  }

  private readBigEndian(byteLength: number): bigint {
    if (this.offset + byteLength > this.bytes.length) {
      fail("malformed-cbor", "truncated CBOR argument");
    }
    let value = 0n;
    for (let index = 0; index < byteLength; index += 1) {
      value = (value << 8n) | BigInt(this.readByte());
    }
    return value;
  }

  readHead(expectedMajor?: number): { major: number; argument: bigint } {
    const initial = this.readByte();
    const major = initial >>> 5;
    const additional = initial & 0x1f;
    if (expectedMajor !== undefined && major !== expectedMajor) {
      fail("malformed-cbor", `expected CBOR major type ${expectedMajor}, received ${major}`);
    }
    if (additional === 31) fail("malformed-cbor", "indefinite-length CBOR is forbidden");
    if (additional >= 28) fail("malformed-cbor", "reserved CBOR additional information");
    let argument: bigint;
    if (additional < 24) argument = BigInt(additional);
    else {
      const byteLength = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : 8;
      argument = this.readBigEndian(byteLength);
      const minimum = byteLength === 1 ? 24n : byteLength === 2 ? 0x100n : byteLength === 4 ? 0x1_0000n : 0x1_0000_0000n;
      if (argument < minimum) fail("malformed-cbor", "non-shortest CBOR integer or length");
    }
    return { major, argument };
  }

  readUnsigned(maximum = 0xffff_ffff_ffff_ffffn): bigint {
    const { argument } = this.readHead(0);
    if (argument > maximum) fail("malformed-cbor", "unsigned integer exceeds its field range");
    return argument;
  }

  readSigned(): bigint {
    const { major, argument } = this.readHead();
    if (major === 0) return argument;
    if (major === 1) return -1n - argument;
    fail("malformed-cbor", "expected a native CBOR integer");
  }

  readTag(): number {
    const { argument } = this.readHead(6);
    if (argument > BigInt(APPLICATION_TAG.cloneString)) {
      fail("malformed-cbor", "unsupported application tag");
    }
    const tag = Number(argument);
    if (tag < APPLICATION_TAG.undefined) fail("malformed-cbor", "unsupported application tag");
    return tag;
  }

  readLength(major: 2 | 4): number {
    const { argument } = this.readHead(major);
    if (argument > MAX_SAFE_BIGINT) fail("malformed-cbor", "CBOR length exceeds safe allocation range");
    const length = Number(argument);
    if (length > this.bytes.length - this.offset) {
      fail("malformed-cbor", "CBOR length exceeds remaining input");
    }
    return length;
  }

  readBytes(expectedLength?: number): Uint8Array {
    const length = this.readLength(2);
    if (expectedLength !== undefined && length !== expectedLength) {
      fail("malformed-cbor", `expected ${expectedLength} payload bytes, received ${length}`);
    }
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  readArrayLength(expectedLength?: number): number {
    const length = this.readLength(4);
    if (expectedLength !== undefined && length !== expectedLength) {
      fail("malformed-cbor", `expected ${expectedLength} array items, received ${length}`);
    }
    return length;
  }

  readBoolean(): boolean {
    const value = this.readByte();
    if (value === 0xf4) return false;
    if (value === 0xf5) return true;
    fail("malformed-cbor", "expected canonical CBOR boolean");
  }

  readSimpleLogical(): null | boolean {
    const value = this.readByte();
    if (value === 0xf4) return false;
    if (value === 0xf5) return true;
    if (value === 0xf6) return null;
    fail("malformed-cbor", "only null, false, and true may use native CBOR simple values");
  }
}

const ARRAY_HOLE = Object.freeze({ arrayHole: true });

function decodeLogicalValue(reader: CborReader, allowHole: boolean): unknown {
  // Native null/booleans are the only logical values that do not carry a tag.
  // A one-byte major-type peek selects that closed native set or the tag path;
  // it never accepts native integers, strings, arrays, maps, or floats.
  const major = reader.peekMajor();
  if (major === 7) return reader.readSimpleLogical();
  if (major !== 6) {
    fail("malformed-cbor", "logical value must use a canonical application tag");
  }
  const tag = reader.readTag();
  switch (tag) {
    case APPLICATION_TAG.undefined:
      reader.readBytes(0);
      return undefined;
    case APPLICATION_TAG.hole:
      reader.readBytes(0);
      if (!allowHole) fail("malformed-cbor", "array-hole tag is only valid inside tag 60009");
      return ARRAY_HOLE;
    case APPLICATION_TAG.number:
      return decodeNumber(reader.readBytes(8));
    case APPLICATION_TAG.bigint:
      return decodeBigInt(reader);
    case APPLICATION_TAG.date:
      return decodeDate(reader);
    case APPLICATION_TAG.arrayBuffer:
      return exactArrayBuffer(reader.readBytes());
    case APPLICATION_TAG.arrayBufferView:
      return decodeView(reader);
    case APPLICATION_TAG.object:
      return decodeObject(reader);
    case APPLICATION_TAG.fieldPresence:
      return decodeFieldPresence(reader);
    case APPLICATION_TAG.array:
      return decodeArray(reader);
    case APPLICATION_TAG.logicalRecord:
      return decodeLogicalRecord(reader);
    case APPLICATION_TAG.cloneString:
      return decodeCloneStringBytes(reader.readBytes());
    default:
      fail("malformed-cbor", "unsupported application tag");
  }
}

function decodeNumber(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const value = view.getFloat64(0, false);
  if (Number.isNaN(value) && !bytes.every((byte, index) => byte === [0x7f, 0xf8, 0, 0, 0, 0, 0, 0][index])) {
    fail("malformed-cbor", "NaN must use the canonical binary64 payload");
  }
  return value;
}

function decodeBigInt(reader: CborReader): bigint {
  reader.readArrayLength(2);
  const sign = Number(reader.readUnsigned(1n));
  const magnitudeBytes = reader.readBytes();
  if (magnitudeBytes.length > 0 && magnitudeBytes[0] === 0) {
    fail("malformed-cbor", "BigInt magnitude has a leading zero");
  }
  if (sign === 1 && magnitudeBytes.length === 0) {
    fail("malformed-cbor", "BigInt negative zero is forbidden");
  }
  let magnitude = 0n;
  for (const byte of magnitudeBytes) magnitude = (magnitude << 8n) | BigInt(byte);
  return sign === 1 ? -magnitude : magnitude;
}

function decodeDate(reader: CborReader): Date {
  const length = reader.readArrayLength();
  if (length !== 1 && length !== 2) fail("malformed-cbor", "Date payload must have one or two items");
  const valid = reader.readBoolean();
  if (!valid) {
    if (length !== 1) fail("malformed-cbor", "invalid Date payload must be [false]");
    return new Date(Number.NaN);
  }
  if (length !== 2) fail("malformed-cbor", "valid Date payload must include epoch milliseconds");
  const epoch = reader.readSigned();
  if (epoch < -MAX_SAFE_BIGINT || epoch > MAX_SAFE_BIGINT) {
    fail("malformed-cbor", "Date epoch exceeds JavaScript's exact integer range");
  }
  const value = new Date(Number(epoch));
  if (Number.isNaN(value.getTime())) fail("malformed-cbor", "Date epoch is outside the valid range");
  return value;
}

function decodeView(reader: CborReader): ArrayBufferView {
  reader.readArrayLength(4);
  const subtype = Number(reader.readUnsigned(11n));
  const byteOffsetBig = reader.readUnsigned();
  const logicalLengthBig = reader.readUnsigned();
  if (byteOffsetBig > MAX_SAFE_BIGINT || logicalLengthBig > MAX_SAFE_BIGINT) {
    fail("malformed-cbor", "view offset or length exceeds JavaScript's exact integer range");
  }
  const byteOffset = Number(byteOffsetBig);
  const logicalLength = Number(logicalLengthBig);
  const buffer = exactArrayBuffer(reader.readBytes());
  const constructor = VIEW_TYPES[subtype]!;
  try {
    if (subtype === 0) return new DataView(buffer, byteOffset, logicalLength);
    return new (constructor as TypedArrayConstructor)(buffer, byteOffset, logicalLength);
  } catch {
    fail("malformed-cbor", "view offset/length is misaligned or outside its backing bytes");
  }
}

type TypedArrayConstructor = new (
  buffer: ArrayBuffer,
  byteOffset: number,
  length: number,
) => Exclude<ArrayBufferView, DataView>;

function decodeObject(reader: CborReader): Record<string, unknown> {
  reader.readArrayLength(2);
  const prototype = Number(reader.readUnsigned(1n));
  const entryCount = reader.readArrayLength();
  const result: Record<string, unknown> = prototype === 1 ? Object.create(null) : {};
  let previousKeyBytes: Uint8Array | undefined;
  for (let index = 0; index < entryCount; index += 1) {
    reader.readArrayLength(2);
    if (reader.readTag() !== APPLICATION_TAG.cloneString) {
      fail("malformed-cbor", "object key must use clone-string tag 60011");
    }
    const keyBytes = reader.readBytes();
    if (previousKeyBytes && compareBytes(previousKeyBytes, keyBytes) >= 0) {
      fail("malformed-cbor", "object keys are duplicated or not byte-sorted");
    }
    previousKeyBytes = keyBytes;
    const key = decodeCloneStringBytes(keyBytes);
    const value = decodeLogicalValue(reader, false);
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return result;
}

function decodeFieldPresence(reader: CborReader): CanonicalCloneFieldPresence {
  const count = reader.readArrayLength();
  const entries: CanonicalCloneFieldPresenceEntry[] = [];
  let previous = -1;
  for (let index = 0; index < count; index += 1) {
    reader.readArrayLength(2);
    const fieldId = Number(reader.readUnsigned(BigInt(MAX_UINT32)));
    const state = Number(reader.readUnsigned(2n)) as CanonicalCloneFieldPresenceState;
    if (fieldId <= previous) fail("malformed-cbor", "field-presence ids are duplicated or not sorted");
    previous = fieldId;
    entries.push([fieldId, state]);
  }
  return new CanonicalCloneFieldPresence(entries);
}

function decodeArray(reader: CborReader): unknown[] {
  reader.readArrayLength(2);
  const declaredLengthBig = reader.readUnsigned(BigInt(MAX_ARRAY_LENGTH));
  const declaredLength = Number(declaredLengthBig);
  const slotCount = reader.readArrayLength();
  if (slotCount !== declaredLength) fail("malformed-cbor", "array slot count differs from declared length");
  const result: unknown[] = [];
  result.length = declaredLength;
  for (let index = 0; index < slotCount; index += 1) {
    const value = decodeLogicalValue(reader, true);
    if (value !== ARRAY_HOLE) result[index] = value;
  }
  return result;
}

function decodeLogicalRecord(reader: CborReader): CanonicalCloneLogicalRecord {
  const count = reader.readArrayLength();
  const entries: CanonicalCloneLogicalRecordEntry[] = [];
  let previous = -1;
  let presenceCount = 0;
  for (let index = 0; index < count; index += 1) {
    reader.readArrayLength(2);
    const fieldId = Number(reader.readUnsigned(BigInt(MAX_UINT32)));
    if (fieldId <= previous) fail("malformed-cbor", "logical-record field ids are duplicated or not sorted");
    previous = fieldId;
    const value = decodeLogicalValue(reader, false);
    if (value instanceof CanonicalCloneFieldPresence) presenceCount += 1;
    entries.push([fieldId, value]);
  }
  if (presenceCount !== 1) {
    fail("malformed-cbor", "logical record must contain exactly one field-presence value");
  }
  return new CanonicalCloneLogicalRecord(entries);
}

function decodeCloneStringBytes(bytes: Uint8Array): string {
  if (bytes.length % 2 !== 0) fail("malformed-cbor", "clone-string byte length must be even");
  const chunks: string[] = [];
  const codeUnits = new Uint16Array(Math.min(bytes.length / 2, 4_096));
  for (let offset = 0; offset < bytes.length;) {
    const length = Math.min(codeUnits.length, (bytes.length - offset) / 2);
    for (let index = 0; index < length; index += 1) {
      codeUnits[index] = (bytes[offset + index * 2]! << 8) | bytes[offset + index * 2 + 1]!;
    }
    chunks.push(String.fromCharCode(...codeUnits.subarray(0, length)));
    offset += length * 2;
  }
  return chunks.join("");
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}
