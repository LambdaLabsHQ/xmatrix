import assert from "node:assert/strict";
import test from "node:test";
import { portableNameKey } from "../dist/portable-name-key.js";

test("sibling names collide across case, spacing, composition and final forms", () => {
  assert.equal(portableNameKey("  Release\t\nNotes "), "release notes");
  assert.equal(portableNameKey("Café"), portableNameKey("Café"));
  assert.equal(portableNameKey("STRAẞE"), portableNameKey("strasse"));
  assert.equal(portableNameKey("Straße"), "strasse");
  assert.equal(portableNameKey("ΛΟΓΟΣ"), portableNameKey("λογος"));
  assert.equal(portableNameKey("İstanbul"), "i̇stanbul");
});
