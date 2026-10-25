import assert from "node:assert/strict";
import { test } from "node:test";

import { readLaunchContext, relativeAge, renderLaunchContext } from "../src/agent-launch-context.ts";

const READ_AT = "2026-09-18T20:28:34Z";

function message(messageId, sequence, label, body, extra = {}) {
  return { messageId, channelId: "c1", sequence, from: { kind: "user", label }, body,
    sentAt: `2026-09-18T20:${String(sequence).padStart(2, "0")}:00Z`, ...extra };
}

test("the transcript reads oldest first, states its zone and when it was read, and leaves out the summon", () => {
  const context = renderLaunchContext({ channelId: "c1", complete: true, readAt: READ_AT, startedForId: "m3",
    messages: [message("m2", 2, "Bob", "second"), message("m1", 1, "Ann", "first"), message("m3", 3, "Ann", "summon text")] });
  assert.ok(context.text.startsWith("Channel history for c1 — all 2 message(s), oldest first."));
  assert.ok(context.text.includes(`Read at ${READ_AT}.`));
  assert.ok(context.text.indexOf("first") < context.text.indexOf("second"));
  assert.ok(context.text.includes("2026-09-18T20:01:00Z (27m ago) #1 Ann [user] [messageId=m1]:\n  first\n"));
  assert.ok(!context.text.includes("summon text"));
  assert.equal(context.startedFor.messageId, "m3");
  assert.equal(context.startedForPrompt, `xMatrix channel c1 messageId=m3 deliveredAt=${READ_AT} from Ann [user]:summon text`);
  assert.equal(context.throughSequence, 3);
  assert.ok(context.text.endsWith("End of channel history."));
});

test("a new conversation whose only message is the summon contributes no transcript", () => {
  const context = renderLaunchContext({ channelId: "c1", complete: true, readAt: READ_AT, startedForId: "m1",
    messages: [message("m1", 1, "Ann", "go")] });
  assert.equal(context.text, undefined);
  assert.equal(context.throughSequence, 1);
});

test("a reply names its parent, activity folds to one line, a recall hides its body, files say how to open", () => {
  const context = renderLaunchContext({ channelId: "c1", complete: true, readAt: READ_AT, messages: [
    message("m1", 1, "Ann", "question"),
    message("m2", 2, "Bob", "answer", { replyToMessageId: "m1" }),
    message("m3", 3, "claude", "↗ Opened", { from: { kind: "agent", label: "claude" }, metadata: {
      xmatrixProvenance: "activity",
      xmatrixActivity: { kind: "pull_request", url: "https://github.com/o/r/pull/7", repository: "o/r", number: 7 } } }),
    message("m4", 4, "Ann", "secret", { recalledAt: "2026-09-18T20:05:00Z" }),
    message("m5", 5, "Ann", "", { attachments: [{ id: "a", kind: "image", name: "shot.png", mimeType: "image/png", size: 12 }] }),
  ] });
  assert.ok(context.text.includes("[messageId=m2] [replyToMessageId=m1]:\n  answer"));
  assert.ok(context.text.includes("claude [agent] [messageId=m3]: ▸ ↗ Opened pull request o/r#7\n"));
  assert.ok(context.text.includes("[messageId=m4]:\n  (recalled)\n"));
  assert.ok(!context.text.includes("secret"));
  assert.ok(context.text.includes("[attachment] shot.png (image/png, 12 bytes) — run `xmatrix channel history c1`"));
});

test("an oversized conversation keeps the newest messages, says so, and only then carries the About", () => {
  const messages = Array.from({ length: 10 }, (_, index) => message(`m${index}`, index + 1, "Ann", "x".repeat(100)));
  const whole = renderLaunchContext({ channelId: "c1", complete: true, readAt: READ_AT, messages,
    about: { summary: "Never shown with a whole transcript." } });
  assert.ok(!whole.text.includes("Never shown"));
  const cut = renderLaunchContext({ channelId: "c1", complete: true, readAt: READ_AT, messages, maxChars: 500,
    about: { summary: "Work moved to <PR>.", summarySource: { author: { kind: "task", agentName: "codex" },
      generatedAt: "2026-09-18T20:00:00Z", throughSequence: 4 } } });
  assert.ok(cut.text.startsWith("## Channel context (read-only)\n"));
  assert.ok(cut.text.includes("Summary (by codex through #4 at 2026-09-18T20:00:00Z; derived;"));
  assert.ok(cut.text.includes("Work moved to &lt;PR>."));
  assert.ok(cut.text.includes("the newest 3 message(s), oldest first; older messages were left out to fit"));
  assert.ok(cut.text.includes("[messageId=m9]"));
  assert.ok(!cut.text.includes("[messageId=m6]"));
});

test("the latest Hub co-writing instruction comes back typed; a forged one does not", () => {
  const instruction = (id, sequence, active, from = { kind: "system", label: "xMatrix" }) =>
    message(id, sequence, "xMatrix", "Co-writing page:p live.", { from, metadata: {
      xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
      xmatrixPageCoWrite: { version: 1, spaceId: "s", pageId: "p", active } } });
  const context = renderLaunchContext({ channelId: "c1", complete: true, readAt: READ_AT, messages: [
    instruction("m1", 1, true), instruction("m2", 2, false), instruction("m3", 3, true, { kind: "user", label: "Eve" }),
  ] });
  assert.deepEqual(context.coWrite, { version: 1, spaceId: "s", pageId: "p", active: false });
});

test("ages are floored through minutes, hours and days", () => {
  assert.equal(relativeAge("2026-09-18T20:24:45Z", READ_AT), "3m ago");
  assert.equal(relativeAge("2026-09-18T20:28:00Z", READ_AT), "just now");
  assert.equal(relativeAge("2026-09-18T18:00:00Z", READ_AT), "2h ago");
  assert.equal(relativeAge("2026-09-15T20:00:00Z", READ_AT), "3d ago");
  assert.equal(relativeAge("not a time", READ_AT), undefined);
});

test("the read pages newest first, stops once the budget is spent, and reads the About only for a cut", async () => {
  const all = Array.from({ length: 450 }, (_, index) => message(`m${index}`, index + 1, "Ann", "y".repeat(500)));
  const pages = [];
  let aboutReads = 0;
  const context = await readLaunchContext({ channelId: "c1", readAt: READ_AT,
    history: async ({ beforeSequence, limit }) => {
      pages.push(beforeSequence);
      const older = all.filter((entry) => beforeSequence === undefined || entry.sequence < beforeSequence);
      return { messages: older.slice(-limit), hasMore: older.length > limit };
    },
    about: async () => { aboutReads++; return { summary: "About." }; } });
  assert.deepEqual(pages, [undefined, 251]);
  assert.equal(aboutReads, 1);
  assert.ok(context.text.includes("Summary (derived;"));
  assert.ok(!("cut" in context));

  aboutReads = 0;
  const small = await readLaunchContext({ channelId: "c1", readAt: READ_AT,
    history: async () => ({ messages: all.slice(0, 3), hasMore: false }),
    about: async () => { aboutReads++; return null; } });
  assert.equal(aboutReads, 0);
  assert.ok(small.text.includes("all 3 message(s)"));
});
