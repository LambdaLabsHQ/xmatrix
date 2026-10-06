import assert from "node:assert/strict";
import { test } from "node:test";

import { judgeMessageSupersession, supersessionCandidate } from "../src/message-supersession.ts";

/**
 * A status report folds once the same sender reports again, but never when the
 * earlier message is addressed to someone or someone engaged with it
 * (docs/design/conversation-activity.md §3.3).
 */

const claude1 = { kind: "agent", identityId: "agent:claude", instanceId: "instance-1", label: "claude" };
const claude2 = { ...claude1, instanceId: "instance-2" };
const yiming = { kind: "user", identityId: "user:yiming", label: "Yiming" };

let sequence = 0;
function message(from, body, extra = {}) {
  sequence += 1;
  return {
    messageId: `m-${sequence}`, sequence, body, from,
    sentAt: new Date(Date.UTC(2026, 8, 27, 18, 0, sequence)).toISOString(),
    messageKind: "xmatrix.message.text", reactions: [], attachments: [], annotations: [],
    ...extra,
  };
}

test("the same Instance's previous report is the candidate, across other senders' messages", () => {
  const earlier = message(claude1, "Progress: running the e2e regression.");
  const window = [
    earlier,
    message(claude2, "Progress: writing the CLI."),
    message(yiming, "looks good"),
    message(claude1, "Progress: CLI done.", { messageKind: "xmatrix.activity" }),
  ];
  const latest = message(claude1, "Progress: regression passed, opening PR 2.");
  window.push(latest);
  assert.equal(supersessionCandidate(window, latest)?.messageId, earlier.messageId);
  // Another Instance of the same Agent is different work.
  const other = message(claude2, "Progress: CLI tests pass.");
  assert.equal(supersessionCandidate([...window, other], other)?.messageId, window[1].messageId);
});

test("anything addressed to someone or engaged with stays whole", () => {
  const cases = [
    [message(claude1, "Should I merge @yiming?"), []],
    [message(claude1, "status", { replyToMessageId: "m-0" }), []],
    [message(claude1, "status", { reactions: [{ emoji: "👍" }] }), []],
    [message(claude1, "status", { attachments: [{ id: "a" }] }), []],
    [message(claude1, "status", { editedAt: "2026-09-27T18:10:00Z" }), []],
    [message(claude1, "status", { annotations: [{ namespace: "xmatrix.superseded",
      authorUserId: "system:xmatrix", payload: { supersededBy: "m-x" } }] }), []],
  ];
  for (const [earlier] of cases) {
    const latest = message(claude1, "Progress: next step.");
    assert.equal(supersessionCandidate([earlier, latest], latest), undefined, earlier.body);
  }
  const earlier = message(claude1, "Progress: step one.");
  const reply = message(yiming, "why?", { replyToMessageId: earlier.messageId });
  const latest = message(claude1, "Progress: step two.");
  assert.equal(supersessionCandidate([earlier, reply, latest], latest), undefined);
  const old = { ...message(claude1, "Progress: old."), sentAt: "2026-09-25T00:00:00.000Z" };
  const now = message(claude1, "Progress: new.");
  assert.equal(supersessionCandidate([old, now], now), undefined);
});

function harness(window, probability) {
  const calls = { evaluate: [], annotate: [] };
  return {
    calls,
    input: (latest) => ({
      env: {}, channelId: "ch-1", messageId: latest.messageId, sequence: latest.sequence,
      principal: { kind: "agent", id: "agent:claude" },
      history: async () => ({ messages: window }),
      evaluate: async (request) => {
        calls.evaluate.push(request);
        return { answers: { superseded: { type: "boolean", probability } } };
      },
      annotate: async (_env, request) => { calls.annotate.push(request); return request; },
    }),
  };
}

test("a clearly superseded report is recorded as the Hub's system annotation", async () => {
  const earlier = message(claude1, "Progress: running the e2e regression.");
  const latest = message(claude1, "Progress: regression passed.");
  const { calls, input } = harness([earlier, latest], 0.93);
  assert.deepEqual(await judgeMessageSupersession(input(latest)),
    { supersededMessageId: earlier.messageId, reason: "superseded" });
  assert.deepEqual(calls.evaluate[0].state, { earlier: earlier.body, later: latest.body });
  assert.equal(calls.evaluate[0].questions.superseded.type, "boolean");
  assert.deepEqual(calls.annotate, [{
    channelId: "ch-1", messageId: earlier.messageId, namespace: "xmatrix.superseded",
    annotationId: `xmatrix.superseded:${earlier.messageId}`,
    payload: { supersededBy: latest.messageId },
  }]);
});

test("an uncertain judgment, no candidate or no Jev records nothing", async () => {
  const earlier = message(claude1, "Found the cause: the cache key omits the Space.");
  const latest = message(claude1, "Progress: writing the fix.");
  const unsure = harness([earlier, latest], 0.55);
  assert.equal((await judgeMessageSupersession(unsure.input(latest))).reason, "still_needed");
  assert.equal(unsure.calls.annotate.length, 0);

  const lone = message(yiming, "first message");
  const none = harness([lone], 0.99);
  assert.equal((await judgeMessageSupersession(none.input(lone))).reason, "not_eligible");
  assert.equal(none.calls.evaluate.length, 0);

  const withoutJev = harness([earlier, latest], 0.99).input(latest);
  delete withoutJev.evaluate;
  assert.equal((await judgeMessageSupersession(withoutJev)).reason, "jev_unavailable");
});
