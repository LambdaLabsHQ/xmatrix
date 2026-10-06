import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTypescriptModule } from "./load-typescript-module.mjs";

const codec = await loadTypescriptModule(
  new URL("../src/relay-v2/canonical-clone-cbor.ts", import.meta.url),
);
const fixture = JSON.parse(await readFile(
  new URL("./fixtures/canonical-clone-cbor-v1-golden.json", import.meta.url),
  "utf8",
));

const highSurrogate = String.fromCharCode(0xd800);
const lowSurrogate = String.fromCharCode(0xdfff);

function makeGoldenValues() {
  const sparse = [];
  sparse.length = 3;
  sparse[1] = undefined;
  sparse[2] = null;

  const plainObject = {};
  plainObject[highSurrogate] = "lone";
  plainObject.a = 1;

  const nullObject = Object.create(null);
  nullObject[lowSurrogate] = "tail";
  nullObject.a = 1;

  const backing = Uint8Array.from([0, 1, 2, 3, 4, 5]).buffer;
  const presence = codec.canonicalCloneFieldPresence([[7, 2], [1, 0], [4, 1]]);
  const logical = codec.canonicalCloneLogicalRecord([
    [9, { z: undefined, a: null }],
    [2, presence],
    [1, `id${highSurrogate}`],
  ]);

  return new Map([
    ["null", null],
    ["false", false],
    ["true", true],
    ["undefined", undefined],
    ["negative-zero", -0],
    ["nan", Number.NaN],
    ["positive-infinity", Number.POSITIVE_INFINITY],
    ["bigint-negative", -258n],
    ["date-valid", new Date(-1)],
    ["date-invalid", new Date(Number.NaN)],
    ["array-buffer", Uint8Array.from([0, 255, 16]).buffer],
    ["uint16-view", new Uint16Array(backing, 2, 2)],
    ["sparse-array", sparse],
    ["plain-object", plainObject],
    ["null-object", nullObject],
    ["clone-string", `A${String.fromCharCode(0)}${highSurrogate}`],
    ["field-presence", presence],
    ["logical-record", logical],
  ]);
}

function fromHex(value) {
  return Uint8Array.from(value.match(/.{2}/gu)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}

function toHex(value) {
  return Buffer.from(value).toString("hex");
}

function assertCodecError(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error?.name, "CanonicalCloneCborV1Error");
    assert.equal(error?.code, code);
    return true;
  });
}

test("golden bytes and domain-separated SHA-256 digests are stable", async () => {
  assert.equal(codec.CANONICAL_CLONE_CBOR_V1_ENCODING, "canonical-clone-cbor-v1");
  assert.equal(fixture.format, "xmatrix-canonical-clone-cbor-v1-golden");
  assert.equal(fixture.encoding, codec.CANONICAL_CLONE_CBOR_V1_ENCODING);
  assert.equal(fixture.digestDomain, `${codec.CANONICAL_CLONE_CBOR_V1_ENCODING}\0`);
  assert.deepEqual(fixture.applicationTags, codec.CANONICAL_CLONE_CBOR_V1_APPLICATION_TAGS);
  const values = makeGoldenValues();
  const fixtureNames = fixture.vectors.map(({ name }) => name);
  assert.equal(new Set(fixtureNames).size, fixture.vectors.length, "fixture vector names must be unique");
  assert.deepEqual(fixtureNames.toSorted(), [...values.keys()].toSorted());

  for (const vector of fixture.vectors) {
    assert.ok(values.has(vector.name), `missing fixture constructor for ${vector.name}`);
    assert.match(vector.hex, /^(?:[0-9a-f]{2})+$/u, `${vector.name} bytes must be lowercase even-length hex`);
    assert.match(vector.digest, /^[0-9a-f]{64}$/u, `${vector.name} digest must be lowercase SHA-256 hex`);
    const value = values.get(vector.name);
    const encoded = codec.encodeCanonicalCloneCborV1(value);
    assert.equal(toHex(encoded), vector.hex, `${vector.name} bytes changed`);
    assert.equal(await codec.digestCanonicalCloneCborV1(value), vector.digest, `${vector.name} digest changed`);
    assert.equal(await codec.digestCanonicalCloneCborV1Bytes(encoded), vector.digest);
    assert.equal(toHex(codec.encodeCanonicalCloneCborV1(codec.decodeCanonicalCloneCborV1(encoded))), vector.hex);
  }
});

test("the wire tag registry is immutable and gap-free", () => {
  assert.ok(Object.isFrozen(codec.CANONICAL_CLONE_CBOR_V1_APPLICATION_TAGS));
  assert.deepEqual(
    Object.values(codec.CANONICAL_CLONE_CBOR_V1_APPLICATION_TAGS),
    Array.from({ length: 12 }, (_, index) => 60_000 + index),
  );
  assert.throws(() => {
    codec.CANONICAL_CLONE_CBOR_V1_APPLICATION_TAGS.number = 1;
  }, TypeError);
});

test("sparse arrays preserve holes, explicit undefined, null, and all Number edges", () => {
  const source = [];
  source.length = 12;
  source[1] = undefined;
  source[2] = null;
  source[3] = false;
  source[4] = 0;
  source[5] = -0;
  source[6] = Number.NaN;
  source[7] = Number.POSITIVE_INFINITY;
  source[8] = Number.NEGATIVE_INFINITY;
  source[9] = Number.MAX_VALUE;
  source[10] = Number.MIN_VALUE;
  source[11] = 9_007_199_254_740_991;

  const decoded = codec.decodeCanonicalCloneCborV1(codec.encodeCanonicalCloneCborV1(source));
  assert.equal(decoded.length, source.length);
  assert.equal(0 in decoded, false);
  assert.equal(1 in decoded, true);
  assert.equal(decoded[1], undefined);
  assert.equal(decoded[2], null);
  assert.equal(decoded[3], false);
  assert.equal(decoded[4], 0);
  assert.ok(Object.is(decoded[5], -0));
  assert.ok(Number.isNaN(decoded[6]));
  assert.equal(decoded[7], Number.POSITIVE_INFINITY);
  assert.equal(decoded[8], Number.NEGATIVE_INFINITY);
  assert.equal(decoded[9], Number.MAX_VALUE);
  assert.equal(decoded[10], Number.MIN_VALUE);
  assert.equal(decoded[11], 9_007_199_254_740_991);
});

test("BigInt, Date, ArrayBuffer, clone strings, and object prototypes round-trip", () => {
  for (const value of [0n, 1n, -1n, 2n ** 255n, -(2n ** 255n)]) {
    assert.equal(codec.decodeCanonicalCloneCborV1(codec.encodeCanonicalCloneCborV1(value)), value);
  }

  const validDate = codec.decodeCanonicalCloneCborV1(
    codec.encodeCanonicalCloneCborV1(new Date(8_640_000_000_000_000)),
  );
  assert.equal(validDate.getTime(), 8_640_000_000_000_000);
  const invalidDate = codec.decodeCanonicalCloneCborV1(
    codec.encodeCanonicalCloneCborV1(new Date(Number.NaN)),
  );
  assert.ok(Number.isNaN(invalidDate.getTime()));

  const sourceBuffer = Uint8Array.from([3, 1, 4, 1, 5]).buffer;
  const decodedBuffer = codec.decodeCanonicalCloneCborV1(codec.encodeCanonicalCloneCborV1(sourceBuffer));
  assert.ok(decodedBuffer instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(decodedBuffer)], [3, 1, 4, 1, 5]);
  assert.notEqual(decodedBuffer, sourceBuffer);

  const sourceString = `${lowSurrogate}x${highSurrogate}${String.fromCharCode(0)}`;
  assert.equal(codec.decodeCanonicalCloneCborV1(codec.encodeCanonicalCloneCborV1(sourceString)), sourceString);

  const first = { z: 1, [highSurrogate]: 2, a: 3 };
  const second = { a: 3, [highSurrogate]: 2, z: 1 };
  assert.deepEqual(codec.encodeCanonicalCloneCborV1(first), codec.encodeCanonicalCloneCborV1(second));
  assert.equal(Object.getPrototypeOf(codec.decodeCanonicalCloneCborV1(codec.encodeCanonicalCloneCborV1(first))), Object.prototype);

  const nullPrototype = Object.create(null);
  nullPrototype.value = "kept";
  const decodedNullPrototype = codec.decodeCanonicalCloneCborV1(
    codec.encodeCanonicalCloneCborV1(nullPrototype),
  );
  assert.equal(Object.getPrototypeOf(decodedNullPrototype), null);
  assert.equal(decodedNullPrototype.value, "kept");
});

test("empty and non-empty object payloads use a complete two-item CBOR array", () => {
  for (const prototype of [Object.prototype, null]) {
    for (const entries of [[], [["value", undefined]]]) {
      const source = prototype === null ? Object.create(null) : {};
      for (const [key, value] of entries) source[key] = value;
      const encoded = codec.encodeCanonicalCloneCborV1(source);
      // tag 60007 followed by a canonical two-item payload array.
      assert.deepEqual(Array.from(encoded.slice(0, 4)), [0xd9, 0xea, 0x67, 0x82]);
      const decoded = codec.decodeCanonicalCloneCborV1(encoded);
      assert.equal(Object.getPrototypeOf(decoded), prototype);
      assert.deepEqual(Object.keys(decoded), entries.map(([key]) => key));
      if (entries.length > 0) assert.equal(decoded.value, undefined);
      assert.deepEqual(codec.encodeCanonicalCloneCborV1(decoded), encoded);
    }
  }
});

test("every fixed TypedArray/DataView subtype preserves offset, length, and exact backing bytes", () => {
  const constructors = [
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
  ];

  for (const [subtype, Constructor] of constructors.entries()) {
    const bytesPerElement = subtype === 0 ? 1 : Constructor.BYTES_PER_ELEMENT;
    const byteOffset = subtype === 0 ? 3 : bytesPerElement;
    const logicalLength = subtype === 0 ? 7 : 2;
    const backing = Uint8Array.from({ length: 40 }, (_, index) => index).buffer;
    const source = subtype === 0
      ? new DataView(backing, byteOffset, logicalLength)
      : new Constructor(backing, byteOffset, logicalLength);
    const decoded = codec.decodeCanonicalCloneCborV1(codec.encodeCanonicalCloneCborV1(source));

    assert.equal(Object.getPrototypeOf(decoded), Constructor.prototype, `subtype ${subtype}`);
    assert.equal(decoded.byteOffset, byteOffset, `subtype ${subtype}`);
    assert.equal(subtype === 0 ? decoded.byteLength : decoded.length, logicalLength, `subtype ${subtype}`);
    assert.deepEqual([...new Uint8Array(decoded.buffer)], [...new Uint8Array(backing)], `subtype ${subtype}`);
  }
});

test("field presence and logical records sort ids and retain direct tagged values", () => {
  const presence = codec.canonicalCloneFieldPresence([[100, 2], [0, 0], [7, 1]]);
  const record = codec.canonicalCloneLogicalRecord([
    [9, { optional: undefined }],
    [2, presence],
    [1, "record"],
  ]);
  assert.deepEqual(presence.entries.map(([fieldId]) => fieldId), [0, 7, 100]);
  assert.deepEqual(record.entries.map(([fieldId]) => fieldId), [1, 2, 9]);

  const decoded = codec.decodeCanonicalCloneCborV1(codec.encodeCanonicalCloneCborV1(record));
  assert.ok(decoded instanceof codec.CanonicalCloneLogicalRecord);
  assert.ok(decoded.entries[1][1] instanceof codec.CanonicalCloneFieldPresence);
  assert.deepEqual(decoded.entries[1][1].entries, [[0, 0], [7, 1], [100, 2]]);

  assertCodecError(() => codec.canonicalCloneFieldPresence([[1, 0], [1, 2]]), "invalid-field-presence");
  assertCodecError(() => codec.canonicalCloneFieldPresence([[MAX_UINT32_PLUS_ONE, 0]]), "invalid-field-presence");
  assertCodecError(() => codec.canonicalCloneLogicalRecord([[1, "no presence"]]), "invalid-logical-record");
  assertCodecError(
    () => codec.canonicalCloneLogicalRecord([[1, presence], [2, presence]]),
    "invalid-logical-record",
  );
});

test("future schema versions and unknown field ids round-trip without filtering or defaults", async () => {
  const unknownFieldId = 0xffff_ffff;
  const unknownPayload = Object.create(null);
  Object.defineProperty(unknownPayload, "__proto__", {
    configurable: true,
    enumerable: true,
    value: { future: undefined },
    writable: true,
  });
  unknownPayload[`vendor${highSurrogate}`] = [null, undefined, 9n];

  const presence = codec.canonicalCloneFieldPresence([
    [unknownFieldId, 2],
    [77, 0],
    [2, 2],
    [1, 2],
  ]);
  const forwardRecord = codec.canonicalCloneLogicalRecord([
    [unknownFieldId, unknownPayload],
    [10, presence],
    [2, "provider.example/future-message"],
    [1, 2],
  ]);
  const reorderedRecord = codec.canonicalCloneLogicalRecord([
    [1, 2],
    [2, "provider.example/future-message"],
    [10, codec.canonicalCloneFieldPresence([[1, 2], [2, 2], [77, 0], [unknownFieldId, 2]])],
    [unknownFieldId, unknownPayload],
  ]);

  const encoded = codec.encodeCanonicalCloneCborV1(forwardRecord);
  assert.deepEqual(codec.encodeCanonicalCloneCborV1(reorderedRecord), encoded);
  const decoded = codec.decodeCanonicalCloneCborV1(encoded);
  assert.ok(decoded instanceof codec.CanonicalCloneLogicalRecord);
  assert.deepEqual(decoded.entries.map(([fieldId]) => fieldId), [1, 2, 10, unknownFieldId]);
  assert.equal(decoded.entries[0][1], 2, "unknown business schema version must not be rewritten");
  assert.equal(decoded.entries[1][1], "provider.example/future-message");
  assert.deepEqual(decoded.entries[2][1].entries, [[1, 2], [2, 2], [77, 0], [unknownFieldId, 2]]);
  const decodedUnknown = decoded.entries[3][1];
  assert.equal(Object.getPrototypeOf(decodedUnknown), null);
  assert.ok(Object.hasOwn(decodedUnknown, "__proto__"));
  assert.equal(Object.getPrototypeOf(decodedUnknown.__proto__), Object.prototype);
  assert.equal(decodedUnknown.__proto__.future, undefined);
  assert.deepEqual(decodedUnknown[`vendor${highSurrogate}`], [null, undefined, 9n]);
  assert.deepEqual(codec.encodeCanonicalCloneCborV1(decoded), encoded);
  assert.equal(
    await codec.digestCanonicalCloneCborV1Bytes(encoded),
    await codec.digestCanonicalCloneCborV1(forwardRecord),
  );
});

const MAX_UINT32_PLUS_ONE = 0x1_0000_0000;

test("unsupported structured-clone families and lossy property shapes fail closed", () => {
  class Custom {
    value = 1;
  }
  const accessor = {};
  Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
  const hidden = {};
  Object.defineProperty(hidden, "value", { enumerable: false, value: 1 });
  const symbolKey = { [Symbol("secret")]: 1 };
  const extraArrayProperty = [];
  extraArrayProperty.extra = 1;

  for (const value of [new Map(), new Set(), new Error("x"), /x/u, new Custom(), accessor, hidden, extraArrayProperty]) {
    assertCodecError(() => codec.encodeCanonicalCloneCborV1(value), "unsupported-object");
  }
  assertCodecError(() => codec.encodeCanonicalCloneCborV1(Symbol("x")), "unsupported-type");
  assertCodecError(() => codec.encodeCanonicalCloneCborV1(() => undefined), "unsupported-type");
  assertCodecError(() => codec.encodeCanonicalCloneCborV1(symbolKey), "unsupported-type");
});

test("cycles and every repeated object, view, or backing-buffer identity fail closed", () => {
  const cycle = {};
  cycle.self = cycle;
  assertCodecError(() => codec.encodeCanonicalCloneCborV1(cycle), "shared-identity");

  const shared = { value: true };
  assertCodecError(() => codec.encodeCanonicalCloneCborV1([shared, shared]), "shared-identity");

  const buffer = new ArrayBuffer(8);
  assertCodecError(
    () => codec.encodeCanonicalCloneCborV1([new Uint8Array(buffer), new DataView(buffer)]),
    "shared-identity",
  );
  assertCodecError(() => codec.encodeCanonicalCloneCborV1([buffer, buffer]), "shared-identity");
});

test("decoder rejects non-deterministic, malformed, or out-of-contract CBOR", () => {
  const malformed = [
    "", // no value
    "00", // Number may not use native CBOR integer
    "f7", // undefined may not use a native simple value
    "fb0000000000000000", // Number may not use native CBOR float
    "f600", // trailing bytes
    "da0000ea6040", // non-shortest tag encoding
    "d9ea605800", // non-shortest empty byte-string length
    "d9ea6140", // hole outside a tagged array
    "d9ea62487ff0000000000001", // non-canonical NaN payload
    "d9ea6382004100", // BigInt magnitude with leading zero
    "d9ea63820140", // negative BigInt zero
    "d9ea6482f400", // invalid Date with an epoch item
    "d9ea6684040101420001", // misaligned Int16 view
    "d9ea67820280", // invalid object prototype discriminator
    "d9ea6782008282d9ea6b420062f682d9ea6b420061f6", // unsorted object keys
    "d9ea6882820200820100", // unsorted field-presence ids
    "d9ea69820281f6", // array slot count differs from declared length
    "d9ea6a818201f6", // logical record without field presence
    "d9ea6b4100", // odd UTF-16BE byte count
    "d9ea6c40", // application tag outside 60000..60011
  ];
  for (const hex of malformed) {
    assertCodecError(() => codec.decodeCanonicalCloneCborV1(fromHex(hex)), "malformed-cbor");
  }
});

test("encoded-byte digest helper validates canonical bytes before hashing", async () => {
  await assert.rejects(
    codec.digestCanonicalCloneCborV1Bytes(fromHex("d9ea62487ff0000000000001")),
    (error) => error?.name === "CanonicalCloneCborV1Error" && error?.code === "malformed-cbor",
  );
});
