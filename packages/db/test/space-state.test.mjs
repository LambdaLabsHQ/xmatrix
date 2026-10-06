import assert from "node:assert/strict";
import test from "node:test";
import { spaceState } from "../dist/agent-registration-rows.js";

test("a Space's disable reads the same from its old and its renamed stored value", () => {
  assert.equal(spaceState("enabled"), "enabled");
  assert.equal(spaceState("paused"), "disabled");
  assert.equal(spaceState("disabled"), "disabled");
  assert.throws(() => spaceState("other"), error => error.code === "invalid_space_state");
});
