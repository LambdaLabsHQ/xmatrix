import assert from "node:assert/strict";
import { test } from "node:test";

import {
  channelAboutRequestId,
  dispatchProductMessageLaunches,
  productMessageControlFinishesBeforeResponse,
  summonFirstMessageHarness,
  dispatchProductMessagePostCommit,
} from "../src/product-message-post-commit.ts";
import { RegistrationAccessError } from "@xmatrix/db";
import { dispatchRegistrationLaunchesAfterMessage } from "../src/registration-launch-dispatch.ts";
import { AgentLaunchHandoverUnavailable } from "../src/agent-launch-coordinator-wake.ts";

test("quota-exhausted dispatch publishes a source-bound failure receipt without a launch or wake", async () => {
  const input = { env: {}, channelId: "channel", messageId: "summon",
    senderKind: "user", senderId: "human", actorUserId: "human", body: "@auto machine:build01 task" };
  const rejected = [{ code: "registration_quota_exhausted" }];
  const notices = [];
  const dispatch = { registration: value => dispatchRegistrationLaunchesAfterMessage(value, {
    refreshQuota: async () => ({}),
    launch: async () => ({ selectionCount: 1, prepared: [], rejected }),
  }) };
  assert.equal(await dispatchProductMessageLaunches(input, dispatch, async value => notices.push(value)), true);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].channelId, input.channelId);
  assert.equal(notices[0].sourceMessageId, input.messageId);
  assert.equal(notices[0].replyToMessageId, input.messageId);
  assert.match(notices[0].body, /Agent launch failed:.*used up its provider quota.*No launch was allocated.*registration_quota_exhausted/);
  assert.doesNotMatch(notices[0].body, /may already|started successfully/);
  await assert.rejects(dispatchProductMessageLaunches(input, dispatch, async () => { throw new Error("offline"); }),
    AgentLaunchHandoverUnavailable, "a missing receipt must fail the request so an idempotent retry can publish it");
});

test("mixed summon results report only rejected allocations and bound unknown errors", async () => {
  const input = { env: {}, channelId: "channel", messageId: "summon",
    senderKind: "user", senderId: "human", actorUserId: "human", body: "@auto task" };
  const notices = [];
  await dispatchProductMessageLaunches(input, { registration: async () => ({ selectionCount: 3,
    prepared: [{ launchId: "successful" }], rejected: [{ code: "registration_quota_exhausted" },
      { code: "private host error" }] }) }, async value => notices.push(value));
  assert.equal(notices.length, 2);
  assert.match(notices[1].body, /registration_launch_rejected/);
  assert.doesNotMatch(notices[1].body, /private host error/);
  const success = [];
  await dispatchProductMessageLaunches(input, { registration: async () => ({ selectionCount: 1,
    prepared: [{ launchId: "successful" }], rejected: [] }) }, async value => success.push(value));
  assert.equal(success.length, 0);
});

test("a mention Jev declined posts no Channel notice; its card says why", async () => {
  const input = { env: {}, channelId: "channel", messageId: "summon",
    senderKind: "user", senderId: "human", actorUserId: "human", body: "Correction: @claude was named in a heading" };
  const notices = [];
  assert.equal(await dispatchProductMessageLaunches(input, { registration: async () => ({ selectionCount: 1,
    prepared: [], rejected: [{ code: "summon_intent_explanation" }, { code: "registration_quota_exhausted" }] }) },
  async value => notices.push(value)), true);
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /registration_quota_exhausted/);
});

test("naming a machine is a card hint; quota and an offline machine still post", async () => {
  const input = { env: {}, channelId: "channel", messageId: "summon",
    senderKind: "user", senderId: "human", actorUserId: "human", body: "@auto task" };
  const notices = [];
  assert.equal(await dispatchProductMessageLaunches(input, { registration: async () => ({ selectionCount: 4,
    prepared: [], rejected: [
      { code: "registration_machine_not_auto_assigned" },
      { code: "registration_machine_ambiguous" },
      { code: "registration_quota_exhausted" },
      { code: "registration_daemon_offline" },
    ] }) }, async value => notices.push(value)), true);
  assert.deepEqual(notices.map(notice => notice.body.match(/\((registration_[a-z_]+)\)/)?.[1]),
    ["registration_quota_exhausted", "registration_daemon_offline"]);
});

test("direct text never bypasses an explicit registration selection or a failed authority read", async () => {
  const input = { env: {}, channelId: "channel", messageId: "message",
    senderKind: "user", senderId: "human", actorUserId: "human", body: "@codex repo:owner/repo task" };
  const dispatch = { registration: async () => ({ selectionCount: 1, prepared: [] }) };
  assert.equal(await dispatchProductMessageLaunches(input, dispatch), true);
  const notices = [];
  assert.equal(await dispatchProductMessageLaunches(input, { ...dispatch, registration: async () => {
    throw new Error("registration authority unavailable");
  } }, async value => notices.push(value)), true);
  assert.equal(notices.length, 1);
});

test("an Agent's @auto launches as its owner and a failure never claims nothing started", async () => {
  const input = { env: {}, channelId: "channel", messageId: "message",
    senderKind: "agent", senderId: "instance", senderRunId: "run", actorUserId: "run-owner", body: "@auto task" };
  const calls = [];
  assert.equal(await dispatchProductMessageLaunches(input, {
    registration: async value => { calls.push(value); return { selectionCount: 1, prepared: [{ launchId: "l" }] }; },
  }), true);
  assert.equal(calls[0], input, "retain the authenticated source identity and owner, not a fabricated Human message");
  const notices = [];
  assert.equal(await dispatchProductMessageLaunches(input, { registration: async () => {
    throw new Error("authority unavailable");
  } }, async value => { notices.push(value); }), true);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].sourceMessageId, input.messageId);
  assert.match(notices[0].body, /may already have been allocated/);
  assert.doesNotMatch(notices[0].body, /authority unavailable/);
});

test("a harness launch exception reports uncertainty without retrying", async () => {
  const input = { env: {}, channelId: "channel", messageId: "message",
    senderKind: "agent", senderId: "instance", actorUserId: "owner", body: "@codex task" };
  let attempts = 0;
  const notices = [];
  const dispatch = { registration: async () => { attempts++; throw new Error("private transport failure"); } };
  assert.equal(await dispatchProductMessageLaunches(input, dispatch, async value => { notices.push(value); }), true);
  assert.equal(attempts, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /could not be confirmed/);
  assert.doesNotMatch(notices[0].body, /No Agent was started|private transport failure/);
  assert.equal(await dispatchProductMessageLaunches(input, dispatch, async () => {
    throw new Error("notice service unavailable");
  }), true, "notice failure must not replay a potentially committed launch");
});

test("an Agent's @auto launches through its derived registration selection", async () => {
  const input = { env: {}, channelId: "channel", messageId: "message",
    senderKind: "agent", senderId: "instance", senderRunId: "run", actorUserId: "owner", body: "@auto repo:owner/repo fix it" };
  assert.equal(await dispatchProductMessageLaunches(input, {
    registration: async () => ({ mode: "composite", selectionCount: 1, prepared: [{ launchId: "l" }] }),
  }), true);
});

test("an Agent's harness shout launches through its derived registration selection", async () => {
  const input = { env: {}, channelId: "channel", messageId: "message",
    senderKind: "agent", senderId: "instance", senderRunId: "run", actorUserId: "owner", body: "@codex review this" };
  const calls = [];
  assert.equal(await dispatchProductMessageLaunches(input, {
    registration: async value => { calls.push(value.actorUserId); return { mode: "composite", selectionCount: 1, prepared: [{ launchId: "l" }] }; },
  }), true);
  assert.deepEqual(calls, ["owner"], "the Agent's owner is the launch actor");
});

test("Channel About runs after the first message and again on each fifth message", () => {
  assert.equal(channelAboutRequestId("ch-1", 1), "channel-about:ch-1:0");
  assert.equal(channelAboutRequestId("ch-1", 2), undefined);
  assert.equal(channelAboutRequestId("ch-1", 4), undefined);
  assert.equal(channelAboutRequestId("ch-1", 5), "channel-about:ch-1:1");
  assert.equal(channelAboutRequestId("ch-1", 9), undefined);
  assert.equal(channelAboutRequestId("ch-1", 10), "channel-about:ch-1:2");
  assert.equal(channelAboutRequestId("ch-1", 100), "channel-about:ch-1:20");
  assert.equal(channelAboutRequestId("ch-1", 101), undefined);
});

test("an unconfirmed launch names its diagnostic reference and stable code, never the exception text", async () => {
  const input = { env: {}, channelId: "channel", messageId: "message",
    senderKind: "user", senderId: "user", actorUserId: "owner", body: "@claude repo:owner/repo fix it" };
  const notices = [];
  const failure = Object.assign(new Error("relation data.secret_table is private"), { code: "space_placement_unavailable" });
  const dispatch = { registration: async () => { throw failure; } };
  assert.equal(await dispatchProductMessageLaunches(input, dispatch, async value => { notices.push(value); }), true);
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /could not be confirmed \(space_placement_unavailable\)/);
  assert.match(notices[0].body, /Diagnostic reference: diag_[0-9a-f-]{36}$/);
  assert.doesNotMatch(notices[0].body, /secret_table/);

  const uncoded = [];
  await dispatchProductMessageLaunches(input, { registration: async () => {
    throw Object.assign(new Error("boom"), { code: "Not A Stable Code" });
  } }, async value => { uncoded.push(value); });
  assert.doesNotMatch(uncoded[0].body, /\(Not A Stable Code\)|boom/);
  assert.match(uncoded[0].body, /Diagnostic reference: diag_/);
});

test("a registration refusal names its cause only when the authority's status makes it certain", async () => {
  const input = { env: {}, channelId: "channel", messageId: "message",
    senderKind: "user", senderId: "user", actorUserId: "owner", body: "@claude repo:owner/repo fix it" };
  const noticeFor = async failure => {
    const notices = [];
    const dispatch = { registration: async () => { throw failure; } };
    assert.equal(await dispatchProductMessageLaunches(input, dispatch, async value => { notices.push(value); }), true);
    return notices[0].body;
  };
  const refused = await noticeFor(new RegistrationAccessError("registration_directory_unavailable", 403));
  assert.match(refused, /^The requested directory is not authorized.*No launch was allocated\. \(registration_directory_unavailable\) Diagnostic reference: diag_[0-9a-f-]{36}$/);
  assert.doesNotMatch(refused, /could not be confirmed|diag_authority/);
  // The same code from an unavailable catalog is not a configuration answer.
  const unavailable = await noticeFor(new RegistrationAccessError("registration_directory_unavailable", 503));
  assert.match(unavailable, /could not be confirmed \(registration_directory_unavailable\)/);
  assert.doesNotMatch(unavailable, /The requested directory is not authorized/);
  // A code outside the preparation vocabulary is never given a certain cause.
  assert.match(await noticeFor(new RegistrationAccessError("runtime_conflict", 409)), /could not be confirmed \(runtime_conflict\)/);
});

test("a mention-less first message asks whether a new conversation starts an Agent, from a Human or an Agent", async () => {
  const base = { env: {}, channelId: "channel", messageId: "message",
    senderKind: "user", senderId: "human", actorUserId: "human", body: "fix the flaky login test", sequence: 1 };
  const asked = [];
  const dispatch = { registration: async () => ({ selectionCount: 0, prepared: [] }),
    newConversation: async input => { asked.push(input.messageId); } };
  assert.equal(await dispatchProductMessageLaunches(base, dispatch), false);
  assert.deepEqual(asked, ["message"]);
  await dispatchProductMessageLaunches({ ...base, sequence: 2 }, dispatch);
  await dispatchProductMessageLaunches({ ...base, body: "@auto fix the flaky login test" }, dispatch);
  await dispatchProductMessageLaunches(base, { ...dispatch, registration: async () => ({ selectionCount: 1, prepared: [] }) });
  assert.deepEqual(asked, ["message"]);
  // People and Agents are read alike; only an Agent's later messages stay unread.
  await dispatchProductMessageLaunches({ ...base, messageId: "agent-first", senderKind: "agent" }, dispatch);
  await dispatchProductMessageLaunches({ ...base, messageId: "agent-later", senderKind: "agent", sequence: 2 }, dispatch);
  assert.deepEqual(asked, ["message", "agent-first"]);
  // A failed start is logged, never a Channel notice about a summon nobody wrote.
  const notices = [];
  assert.equal(await dispatchProductMessageLaunches(base, { ...dispatch, newConversation: async () => {
    throw new Error("unavailable");
  } }, async value => notices.push(value)), false);
  assert.equal(notices.length, 0);
  // Nothing was summoned, so the send answers before Jev reads the message.
  assert.equal(productMessageControlFinishesBeforeResponse("fix the flaky login test"), false);
});


test("explicit controls and a nested handoff successor cannot allocate a second first-message Run", async () => {
  for (const body of ["@codex /model test-model", "@helper:1 /effort high", "/stop all", "@codex:3:handoff:@auto", "@codex:3:reborn"]) {
    let launches = 0;
    await dispatchProductMessageLaunches({ env: {}, channelId: "channel", messageId: "first",
      senderKind: "user", senderId: "owner", actorUserId: "owner", sequence: 1, body }, {
      registration: async () => { launches++; return { selectionCount: 0, prepared: [] }; },
      newConversation: async () => { launches++; },
    });
    assert.equal(launches, 0, body);
  }
});

test("a harness decided for a first message is summoned by an ordinary @ reply through the same pipeline", async () => {
  const appended = [];
  const committed = [];
  const dependencies = {
    append: async (_env, channelId, command) => { appended.push({ channelId, command }); return new Response("{}"); },
    postCommit: async input => { committed.push(input); },
  };
  const input = { env: {}, channelId: "channel", messageId: "first", actorUserId: "author", harness: "codex" };
  await summonFirstMessageHarness(input, dependencies);
  const [{ command }] = appended;
  assert.equal(command.messageId, "xmatrix-summon:first");
  assert.equal(command.body, "@codex launch:force");
  assert.equal(command.residual.replyToMessageId, "first");
  assert.equal(command.xmatrixAuthor, true, "xMatrix is the author");
  assert.deepEqual(command.principal, { kind: "user", id: "author" }, "authorized as the first message's author");
  assert.deepEqual(committed.map(value => [value.messageId, value.body, value.senderKind, value.senderId, value.actorUserId]),
    [["xmatrix-summon:first", "@codex launch:force", "system", "xmatrix", "author"]]);
  // A retry reuses the same message, so it appends and launches nothing new.
  await summonFirstMessageHarness(input, dependencies);
  assert.equal(appended[1].command.messageId, command.messageId);
  await assert.rejects(summonFirstMessageHarness(input, { ...dependencies,
    append: async () => new Response("{}", { status: 503 }) }), /append failed \(503\)/u);
  assert.equal(committed.length, 2, "nothing is interpreted when the append failed");
});

test("a message's side interpretation runs in the background, never holding its response", async () => {
  const scheduled = [];
  const input = { env: {}, channelId: "channel", messageId: "first", senderKind: "system", senderId: "xmatrix",
    actorUserId: "human", body: "@ok", sequence: 1, scheduleBackground: task => scheduled.push(task) };
  await dispatchProductMessagePostCommit(input);
  assert.equal(scheduled.length, 1, "the About for a first message is handed to the background scheduler");
  await scheduled[0];
});
