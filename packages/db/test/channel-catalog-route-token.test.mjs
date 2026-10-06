import assert from "node:assert/strict";
import test from "node:test";

import { legacyChannelRouteUuidRanges } from "../dist/index.js";

const target = "775b105d-ac07-4e2c-b966-d8bb09c702ed";

test("legacy Channel route tokens become bounded UUID primary-key ranges", () => {
  const ranges = legacyChannelRouteUuidRanges("c72dq68erek");

  assert.ok(ranges.length > 0);
  assert.ok(ranges.length <= 16);
  assert.equal(ranges.some(({ lowerChannelId, upperChannelId }) =>
    lowerChannelId <= target && target <= upperChannelId), true);
  assert.equal(ranges.some(({ lowerChannelId, upperChannelId }) =>
    lowerChannelId <= "a018bbdb-4b40-417b-932d-dbe333bfa7e4" &&
      "a018bbdb-4b40-417b-932d-dbe333bfa7e4" <= upperChannelId), false);
});

test("invalid legacy Channel route tokens never produce database ranges", () => {
  for (const token of ["", "c72", "x72dq68erek", "c72dq68ere!"]) {
    assert.deepEqual(legacyChannelRouteUuidRanges(token), []);
  }
});
