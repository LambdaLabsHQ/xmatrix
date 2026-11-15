import assert from "node:assert/strict";
import test from "node:test";
import { triggerNote } from "../src/relay-authority-scheduled-message-delivery.ts";

test("an occurrence's message names the events that fired it, and only safe links", () => {
  assert.equal(triggerNote([]), "");
  assert.equal(triggerNote([
    { summary: "Pull request #9 was merged into main", url: "https://github.com/acme/widgets/pull/9" },
    { summary: "A claim on #ui was released", url: "javascript:alert(1)" },
    { url: "https://example.com" },
  ]), "Triggered by:\n- Pull request #9 was merged into main (https://github.com/acme/widgets/pull/9)\n" +
    "- A claim on #ui was released");
});
