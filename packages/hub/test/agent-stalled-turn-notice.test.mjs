import assert from "node:assert/strict";
import test from "node:test";

import { stalledTurnNotice } from "../src/runtime-transport/agent-stalled-turn-notice.ts";

const base = { channelId: "ch-1", instanceId: "ch-1:3", address: "@deepseek:3", now: 1_000_000 + 6 * 60_000 };
const running = (issue) => ({ status: "running", activeChannelId: "ch-1", activeMessageId: "m-1", ...(issue ? { issue } : {}) });

test("a turn the host reports stalled is said once, under the message it answers", () => {
  // Production 11-06/11-10: DeepSeek accepted a message and then said nothing for hours.
  const stalled = { kind: "stalled", sinceMillis: 1_000_000 };
  const notice = stalledTurnNotice({ ...base, previous: running(), next: running(stalled) });
  assert.equal(notice.replyToMessageId, "m-1");
  assert.match(notice.body, /^@deepseek:3 has shown no progress on this for 6 minutes\. /u);
  assert.match(notice.body, /@deepseek:3:stop/u);
  // The same stall reported again (any later presence) is not said twice.
  assert.equal(stalledTurnNotice({ ...base, previous: running(stalled), next: running(stalled) }), undefined);
  // A later stall after progress is a new one.
  const later = { kind: "stalled", sinceMillis: 1_200_000 };
  assert.notEqual(stalledTurnNotice({ ...base, previous: running(stalled), next: running(later) })?.key, notice.key);
});

test("nothing is said without a stall, a running turn, or a message in this Channel", () => {
  assert.equal(stalledTurnNotice({ ...base, next: running() }), undefined);
  assert.equal(stalledTurnNotice({ ...base, next: running({ kind: "retrying", sinceMillis: 1 }) }), undefined);
  assert.equal(stalledTurnNotice({ ...base, next: { ...running({ kind: "stalled", sinceMillis: 1 }), status: "idle" } }), undefined);
  assert.equal(stalledTurnNotice({ ...base, next: { status: "running", issue: { kind: "stalled", sinceMillis: 1 } } }), undefined);
  assert.equal(stalledTurnNotice({ ...base,
    next: { ...running({ kind: "stalled", sinceMillis: 1 }), activeChannelId: "elsewhere" } }), undefined);
});
