import assert from "node:assert/strict";
import test from "node:test";
import { deriveHumanConnectionUrl } from "../dist/index.js";

test("the Human connection has its own endpoint", () => {
  assert.equal(deriveHumanConnectionUrl("https://hub.example.test"), "wss://hub.example.test/ws/humans");
});
