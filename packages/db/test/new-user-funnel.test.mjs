import assert from "node:assert/strict";
import test from "node:test";
import { deviceOf, personKey, platformOf, summarizeFunnel, turnFailureClass } from "../scripts/new-user-funnel.mjs";

test("a first sign-in names the device and platform without keeping the agent string", () => {
  assert.equal(deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Safari/604.1"), "phone");
  assert.equal(deviceOf("Mozilla/5.0 (Macintosh) xMatrix/1.0.557 Chrome/146 Electron/41.10"), "desktop_app");
  assert.equal(deviceOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0"), "desktop_web");
  assert.equal(deviceOf("xMatrix device sign-in · Ebony-PC windows-x86_64"), "cli");
  assert.equal(deviceOf(null), "unknown");
  assert.equal(platformOf("Mozilla/5.0 (X11; Linux x86_64) Edg/155"), "linux");
  assert.equal(platformOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "macos");
});

test("a turn failure is kept as its class, never its text", () => {
  assert.equal(turnFailureClass("xMatrix could not complete this claude turn: Failed to authenticate: OAuth session expired"),
    "harness_signed_out");
  assert.equal(turnFailureClass("xMatrix could not complete this codex turn: usage limit reached"), "usage_limited");
  assert.equal(turnFailureClass("xMatrix could not complete this grok turn: API Error 529"), "turn_failed");
  assert.match(personKey("user-1"), /^[0-9a-f]{10}$/u);
});

test("the funnel counts each person at every step they reached and where they stopped", () => {
  const summary = summarizeFunnel([{ stage: "registered" }, { stage: "space" }, { stage: "reply" }, { stage: "page" }]);
  assert.equal(summary.people, 4);
  assert.deepEqual(summary.reached, { registered: 4, space: 3, machine: 2, agents: 2, message: 2, reply: 2, page: 1 });
  assert.equal(summary.stoppedAt.space, 1);
  assert.equal(summary.stoppedAt.reply, 1);
});
