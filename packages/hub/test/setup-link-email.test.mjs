import assert from "node:assert/strict";
import { test } from "node:test";

import { AGENT_PRESETS } from "@xmatrix/protocol";
import { setupLinkEmail } from "../src/setup-link-email.ts";

test("the setup link mail sends its reader to the app on the computer their agents use", () => {
  const message = setupLinkEmail("https://xmatrix.sh");
  assert.equal(message.subject, "Bring your agents into xMatrix");
  assert.match(message.text, /Open xMatrix on that computer and sign in: https:\/\/xmatrix\.sh\/app/u);
  assert.match(message.html, /href="https:\/\/xmatrix\.sh\/app"/u);
  // Every agent the registry can bring in is counted, so a new harness needs no edit here.
  const supported = AGENT_PRESETS.filter((preset) => preset.id !== "custom").length;
  assert.match(message.text, new RegExp(`any of the ${supported} agents xMatrix supports`, "u"));
});

test("the setup link mail escapes the origin it links to", () => {
  const message = setupLinkEmail('https://xmatrix.test/"><script>');
  assert.doesNotMatch(message.html, /<script>/u);
});
