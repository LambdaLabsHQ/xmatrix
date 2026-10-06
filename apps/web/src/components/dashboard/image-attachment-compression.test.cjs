const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { encodedImageDimensions, fitImageDimensions, nextImageCompressionDimensions } = require("./image-attachment-compression.ts");

test("image compression dimensions preserve aspect ratio at the upload render ceiling", () => {
  assert.deepEqual(fitImageDimensions({ width: 4000, height: 3000 }, 1600), {
    width: 1600,
    height: 1200,
  });
  assert.deepEqual(fitImageDimensions({ width: 900, height: 1200 }, 1600), {
    width: 900,
    height: 1200,
  });
});

test("oversized JPEG results rescale directly toward the upload target", () => {
  const next = nextImageCompressionDimensions({
    dimensions: { width: 1600, height: 1200 },
    encodedBytes: 2_000_000,
    targetBytes: 1_000_000,
  });
  assert.ok(next.width <= 1_087, "the next encode should skip the old small fixed reduction");
  assert.ok(next.height <= 816, "the next encode should preserve aspect ratio");
  assert.deepEqual(
    nextImageCompressionDimensions({
      dimensions: { width: 1600, height: 1200 },
      encodedBytes: 900_000,
      targetBytes: 1_000_000,
    }),
    { width: 1600, height: 1200 },
  );
});

test("image dimension headers are read without decoding a full bitmap", () => {
  const png = new Uint8Array(24);
  png.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(png.buffer).setUint32(16, 3840);
  new DataView(png.buffer).setUint32(20, 2160);
  assert.deepEqual(encodedImageDimensions(png), { width: 3840, height: 2160 });

  const jpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 4, 56, 7, 128, 3, 1, 17, 0, 2, 17, 1, 3, 17, 1,
  ]);
  assert.deepEqual(encodedImageDimensions(jpeg), { width: 1920, height: 1080 });

  const webp = new Uint8Array(30);
  webp.set(Buffer.from("RIFF\x16\0\0\0WEBPVP8X\n\0\0\0", "binary"));
  webp.set([0, 0, 0, 0, 127, 7, 0, 55, 4, 0], 20);
  assert.deepEqual(encodedImageDimensions(webp), { width: 1920, height: 1080 });
  assert.equal(encodedImageDimensions(new Uint8Array([0xff, 0xd8])), null);
});
