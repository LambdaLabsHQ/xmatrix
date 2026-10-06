const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { neighbourRoom, planMentionBands } = require("./composer-mention-bands.ts");

// The composer: 14px Inter on a 19.32px line, baseline 15px into each line box.
const METRICS = { fontSize: 14, lineHeight: 19.32, firstLineTop: 8.8, baseline: 15 };
const LATIN = { ascent: 10.6, descent: 2.7 };
const CJK = { ascent: 12.2, descent: 1.9 };
const word = (line, left, right, ink = LATIN) => ({ line, left, right, ...ink });

test("a mention is one band per line, never a tile per word", () => {
  const bands = planMentionBands([{
    fragments: [word(0, 10, 55), word(0, 59, 250)],
    roomBefore: neighbourRoom("edge", 0), roomAfter: neighbourRoom("edge", 0),
  }], METRICS);
  assert.equal(bands.length, 1);
  const [band] = bands;
  // Full padding at both line edges, symmetric around the text.
  assert.ok(Math.abs(band.left - (10 - 14 * 0.16)) < 1e-9);
  assert.ok(Math.abs(band.left + band.width - (250 + 14 * 0.16)) < 1e-9);
});

test("the band takes only part of the room its neighbours leave, the same on both sides", () => {
  const [spaced] = planMentionBands([{ fragments: [word(0, 20, 60)],
    roomBefore: neighbourRoom("space", 4), roomAfter: neighbourRoom("edge", 0) }], METRICS);
  assert.ok(Math.abs((20 - spaced.left) - 1.2) < 1e-9);
  assert.ok(Math.abs((spaced.left + spaced.width - 60) - 1.2) < 1e-9);
  const [touching] = planMentionBands([{ fragments: [word(0, 20, 60)],
    roomBefore: neighbourRoom("space", 4), roomAfter: neighbourRoom("glyph", 0.4) }], METRICS);
  assert.ok(Math.abs((20 - touching.left) - 0.18) < 1e-9);
});

test("a wrapped mention meets the line edges with full padding", () => {
  const bands = planMentionBands([{
    fragments: [word(0, 300, 350), word(1, 2, 190)],
    roomBefore: neighbourRoom("space", 4), roomAfter: neighbourRoom("space", 4),
  }], METRICS);
  assert.equal(bands.length, 2);
  // Each fragment is limited only by its own inner neighbour.
  assert.ok(Math.abs((300 - bands[0].left) - 1.2) < 1e-9);
  assert.ok(Math.abs((2 - bands[1].left) - 1.2) < 1e-9);
  assert.equal(bands[1].lineOrdinal, 1);
});

test("bands never reach the next line and sit on their line's ink", () => {
  const bands = planMentionBands([
    { fragments: [word(0, 10, 60), word(1, 10, 60)], roomBefore: Infinity, roomAfter: Infinity },
    { fragments: [word(1, 80, 120, CJK)], roomBefore: Infinity, roomAfter: Infinity },
  ], METRICS);
  const [first, second, third] = bands;
  assert.ok(first.height <= METRICS.lineHeight - 3 + 1e-9);
  assert.ok(second.top - (first.top + first.height) >= 2, "air between two lines' bands");
  // Two mentions on one line share a vertical position (the line's ink).
  assert.equal(second.top, third.top);
  // A Latin-only line is centred on its own ink, not on the font's box.
  const baseline = METRICS.firstLineTop + METRICS.baseline;
  const inkCentre = baseline - (LATIN.ascent - LATIN.descent) / 2;
  assert.ok(Math.abs(first.top + first.height / 2 - inkCentre) <= 0.2);
});
