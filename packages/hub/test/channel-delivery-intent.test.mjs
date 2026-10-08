import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * A delivery says whether it is work or orientation, and it says it once, for
 * every audience. System notices are the Hub narrating something about the
 * channel — a queued summon, a run failure, a machine request. They are
 * addressed to the humans watching; handing one to an Instance as work made
 * the Instance act on the Hub's own commentary.
 */
import {
  agentChannelMessageDeliveryIntent,
  agentChannelMessageRequestsInterrupt,
  channelMessage,
  channelMessageDeliveryIntent,
} from "../src/runtime-transport/channel-message-frame.ts";

const BASE = {
  channelId: "ch-1",
  messageId: "msg-1",
  sequence: 4,
  from: { kind: "user", label: "Yiming", userId: "user-1", email: "yiming@example.com" },
  body: "hello",
  sentAt: "2026-08-05T00:00:00.000Z",
};

const framed = (overrides) => channelMessage({ ...BASE, ...overrides });

test("an exact Profile ID addresses only the selected same-name Agent", () => {
  const body = "@agent:owner:second:2 inspect";
  const recipient = { agentName: "codex", agentId: "agent:owner:second", channelInstanceId: "2" };
  const peer = { ...recipient, agentId: "agent:owner:first" };
  const scheduled = framed({ body, metadata: { xmatrixProvenance: "scheduled_automation" } });
  assert.equal(agentChannelMessageDeliveryIntent(scheduled, recipient), "work");
  assert.equal(agentChannelMessageDeliveryIntent(scheduled, peer), "context");
  const message = framed({ body, from: { kind: "agent", agentId: "caller", label: "caller" } });
  assert.equal(agentChannelMessageRequestsInterrupt(message, recipient), true);
  assert.equal(agentChannelMessageRequestsInterrupt(message, peer), false);
});

test("quoted instance addresses neither route Automation work nor interrupt peers", () => {
  const recipient = { agentName: "codex", channelInstanceId: "2" };
  for (const body of ["`@codex:2`", "> @codex:2", "```\n@codex:2\n```", "[@codex:2](https://example.test)"]) {
    assert.equal(agentChannelMessageDeliveryIntent(framed({ body,
      metadata: { xmatrixProvenance: "scheduled_automation" } }), recipient), "context");
    assert.equal(agentChannelMessageRequestsInterrupt(framed({ body,
      from: { ...BASE.from, kind: "agent", identityId: "peer" } }), recipient), false);
  }
  assert.equal(agentChannelMessageDeliveryIntent(framed({ body: "ordinary Human text" }), recipient), "work");
});

test("ambiguous live display names cannot route scheduled work or interrupt both peers", () => {
  const recipient = { agentName: "codex", agentId: "agent:owner:first", channelInstanceId: "2", nameIsAmbiguous: true };
  const scheduled = framed({ body: "@codex:2 inspect", metadata: { xmatrixProvenance: "scheduled_automation" } });
  assert.equal(agentChannelMessageDeliveryIntent(scheduled, recipient), "context");
  assert.equal(agentChannelMessageRequestsInterrupt(framed({ body: "@codex:2 inspect",
    from: { ...BASE.from, kind: "agent", identityId: "peer" } }), recipient), false);
  assert.equal(agentChannelMessageDeliveryIntent({ ...scheduled, body: "@agent:owner:first:2 inspect" }, recipient), "work");
});

test("a connected app's post is work that waits behind the active turn", () => {
  const recipient = { agentName: "claude", channelInstanceId: "1" };
  const verdict = framed({ body: "CI failed on [acme/app#7](https://github.com/acme/app/pull/7) at abc1234: test.",
    from: { kind: "app", appId: "github", label: "GitHub" } });
  assert.equal(agentChannelMessageDeliveryIntent(verdict, recipient), "work");
  assert.equal(agentChannelMessageRequestsInterrupt(verdict, recipient), false);
  assert.equal(agentChannelMessageRequestsInterrupt(framed({ body: "stop and look" }), recipient), true,
    "a person's message still steers");
});

test("a system fact is context, whoever is receiving it", () => {
  const notice = framed({
    messageId: "system:msg-1:9f2a",
    body: "xMatrix could not start @codex yet: the daemon on host-1 has no live control session. The run is queued and will start when that daemon reconnects.",
    metadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true },
  });
  assert.equal(channelMessageDeliveryIntent(notice), "context");
});

test("scheduled Automation is work only for its exact live instance mention", () => {
  const scheduled = framed({
    body: "@codex:2 inspect the latest build",
    metadata: { xmatrixProvenance: "scheduled_automation" },
  });
  assert.equal(
    agentChannelMessageDeliveryIntent(scheduled, { agentName: "codex", channelInstanceId: "2" }),
    "work",
  );
  assert.equal(
    agentChannelMessageDeliveryIntent(scheduled, { agentName: "codex", channelInstanceId: "1" }),
    "context",
  );
  assert.equal(
    agentChannelMessageDeliveryIntent(scheduled, { agentName: "claude", channelInstanceId: "2" }),
    "context",
  );
});

test("scheduled one-shot and bare expressions are context for existing live instances", () => {
  for (const body of [
    "@codex:once:LambdaLabsHQ/xmatrix inspect once",
    "Summarize the Channel state",
  ]) {
    const scheduled = framed({ body, metadata: { xmatrixProvenance: "scheduled_automation" } });
    assert.equal(
      agentChannelMessageDeliveryIntent(scheduled, { agentName: "codex", channelInstanceId: "1" }),
      "context",
    );
  }
});

test("an ordinary message is work, with or without metadata", () => {
  assert.equal(channelMessageDeliveryIntent(framed({})), "work");
  assert.equal(
    channelMessageDeliveryIntent(framed({ metadata: { appMentions: ["codex"] } })),
    "work",
  );
});

test("Agent stop commands are audit context, never work for live peers", () => {
  const recipient = { agentName: "codex", channelInstanceId: "2" };
  for (const body of ["@codex:1:stop", "/kill all"]) {
    const command = framed({ body });
    assert.equal(agentChannelMessageDeliveryIntent(command, recipient), "context");
    assert.equal(agentChannelMessageRequestsInterrupt(command, recipient), false);
  }
});

test("Auto summons are context for existing live instances", () => {
  const recipient = { agentName: "codex", channelInstanceId: "16" };
  const summon = framed({ body: "@auto harness:claude repo:LambdaLabsHQ/xmatrix test" });
  assert.equal(agentChannelMessageDeliveryIntent(summon, recipient), "context");
  assert.equal(channelMessageDeliveryIntent(summon), "context", "catch-up keeps the same launch intent");
  assert.equal(agentChannelMessageRequestsInterrupt(summon, recipient), false);
  assert.equal(agentChannelMessageDeliveryIntent(framed({ body: "please test the build" }), recipient), "work");
  for (const body of ["`@auto harness:claude`", "> @auto harness:claude", "```\n@auto harness:claude\n```"]) {
    assert.equal(agentChannelMessageDeliveryIntent(framed({ body }), recipient), "work");
  }
});

test("Agent peer replies queue unless they address this exact Instance", () => {
  const peer = framed({
    from: {
      kind: "agent",
      identityId: "agent:critic",
      userId: "user-1",
      label: "Critic",
      email: "critic@example.test",
    },
    body: "My analysis is ready",
  });
  const recipient = { agentName: "Analyst", channelInstanceId: "2" };
  assert.equal(agentChannelMessageDeliveryIntent(peer, recipient), "work");
  assert.equal(agentChannelMessageRequestsInterrupt(peer, recipient), false);
  assert.equal(
    agentChannelMessageRequestsInterrupt({ ...peer, body: "@Analyst:2 revise this" }, recipient),
    true,
  );
  assert.equal(
    agentChannelMessageRequestsInterrupt({ ...peer, body: "@Analyst:3 revise this" }, recipient),
    false,
  );
});

test("provenance decides, not the id shape", () => {
  // `system:` ids are how notices happen to be named today. Matching the name
  // instead of the provenance is what the previous guard did, and it could not
  // see a notice named any other way.
  const namedLikeANotice = framed({
    messageId: "system:msg-1:9f2a",
    body: "not actually a system fact",
  });
  assert.equal(channelMessageDeliveryIntent(namedLikeANotice), "work");
});

test("a thread root copy replays as context, never as fresh work", () => {
  assert.equal(
    channelMessageDeliveryIntent(framed({ messageId: "thread-root:dfb46fe6-9b66-4145-bd6b-98e96074c82a" })),
    "context",
  );
  assert.equal(
    channelMessageDeliveryIntent(framed({ messageId: "thread-root:any-channel" , metadata: { appMentions: ["codex"] } })),
    "context",
    "the root copy stays context even with work-like metadata",
  );
});

test("an activity entry is context for every Instance, even when a step title names one", () => {
  const recipient = { agentName: "codex", channelInstanceId: "2" };
  const activity = framed({
    body: "✓ ask codex:2 to review",
    from: { kind: "agent", agentId: "agent-1", label: "claude", instanceId: "instance-1" },
    metadata: {
      xmatrixProvenance: "activity",
      xmatrixActivity: { kind: "plan", completed: ["ask @codex:2 to review"], steps: [] },
    },
  });
  assert.equal(channelMessageDeliveryIntent(activity), "context");
  assert.equal(agentChannelMessageDeliveryIntent(activity, recipient), "context");
});

test("a frame carries the Hub's supersession judgment but never raw annotations", () => {
  const judged = framed({
    annotations: [
      { namespace: "xmatrix.superseded", authorUserId: "system:xmatrix", payload: { supersededBy: "msg-9" } },
      { namespace: "memory", authorUserId: "user-1", payload: { note: "private" } },
    ],
  });
  assert.equal(judged.supersededBy, "msg-9");
  assert.equal(judged.annotations, undefined);
  const forged = framed({
    annotations: [{ namespace: "xmatrix.superseded", authorUserId: "user-1", payload: { supersededBy: "msg-9" } }],
  });
  assert.equal(forged.supersededBy, undefined);
  const recalled = framed({
    recalledAt: "2026-09-27T18:30:00Z",
    annotations: [{ namespace: "xmatrix.superseded", authorUserId: "system:xmatrix", payload: { supersededBy: "msg-9" } }],
  });
  assert.equal(recalled.supersededBy, undefined);
});

test("a reborn or handoff is context: the Instance it stops spends no turn on it", () => {
  const recipient = { agentName: "claude", channelInstanceId: "1" };
  for (const body of ["@claude:1:handoff:@auto", "@claude:1:handoff:@codex finish the migration",
    "@claude:1:reborn"]) {
    const message = framed({ body });
    assert.equal(agentChannelMessageDeliveryIntent(message, recipient), "context", body);
    assert.equal(agentChannelMessageRequestsInterrupt(message, recipient), false, body);
  }
  assert.equal(agentChannelMessageDeliveryIntent(framed({ body: "@claude:1 please hand off soon" }), recipient),
    "work");
});
