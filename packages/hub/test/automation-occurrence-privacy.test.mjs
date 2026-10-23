import assert from "node:assert/strict";
import test from "node:test";
import * as protocol from "@xmatrix/protocol";
import { dispatchScheduledMessageOccurrence } from "../src/relay-authority-scheduled-message-delivery.ts";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";

// Exercise the real delivery-to-conversation boundary: a public Page must not
// publish a connector event merely because its authorized author received it.
const load = await compileCommonJsSourceModule(new URL("../src/automation-occurrence-conversation.ts", import.meta.url));

function fixture(existingMode) {
  const opened = [], appended = [];
  const page = { pageId: "page", body: "[Audit](xmatrix:automation/automation)", accessMode: "space" };
  const conversations = load(name => ({
    "@xmatrix/db": { PostgresPageRepository: class {
      async read() { return { page }; }
      async tree() { return { pages: [page] }; }
      async link() {}
    } },
    "@xmatrix/protocol": protocol,
    "./postgres-authority-fleet": { createPostgresAuthorityDatabase: () => ({}) },
    "./deterministic-id": { deterministicConversationId: async () => "occurrence-channel" },
    "./system-conversation": { openConversation: async (_env, input) => { opened.push(input); } },
    "./spaces": { getChannel: async () => ({ channel: { spaceId: "space", mode: existingMode ?? opened.at(-1)?.mode } }) },
  })[name] ?? {});
  return { opened, appended, async dispatch({ triggers, events } = {}) {
    await dispatchScheduledMessageOccurrence({
      appendMessage: async command => { appended.push(command); }, schedulePostCommit() {},
      openConversation: input => conversations.openOccurrenceConversation({}, {
        spaceId: "space", pageId: "page", automationId: "automation", occurrenceId: input.occurrence.id,
        name: "Audit", scheduledFor: input.occurrence.scheduled_for, userId: input.userId, body: input.body,
        privateEvents: input.privateEvents,
      }),
    }, { id: "occurrence", message_id: "message", scheduled_for: "2026-10-17T00:00:00.000Z", trigger_events: events },
    { id: "automation", channel_id: "timing-channel", owner_user_id: "author" },
    { payloadVersion: 2, name: "Audit", message: { body: "Audit changes" }, ...(triggers ? { triggers } : {}) },
    { async requireEvaluationAuthority() {}, async markPrepared() {}, async finishMessage() {} });
  } };
}

test("connector and GitHub event occurrences keep private context in a closed conversation", async () => {
  for (const input of [
    { events: [{ kind: "event", summary: "SYNTHETIC-PRIVATE-SUMMARY" }] },
    { events: [{ kind: "merged", summary: "SYNTHETIC-PRIVATE-SUMMARY" }] },
    { events: [{ kind: "owed", summary: "A private pull request merged", url: "https://example.invalid/private-pull" }] },
    { triggers: [{ kind: "ci-failed", repository: "org/private" }] },
    { triggers: [{ kind: "event", provider: "slack", source: "*" }] },
  ]) {
    const f = fixture();
    await f.dispatch(input);
    assert.equal(f.opened[0].mode, "closed");
    assert.equal(f.appended.length, 1);
  }
  for (const input of [{}, { triggers: [{ kind: "owed" }] }]) {
    const f = fixture();
    await f.dispatch(input);
    assert.equal(f.opened[0].mode, "open", "ordinary Page cadence keeps its visibility");
  }
});

test("retrying a pre-fix open occurrence cannot append newly received private content", async () => {
  const f = fixture("open");
  await assert.rejects(f.dispatch({ events: [{ kind: "event", summary: "SYNTHETIC-PRIVATE-SUMMARY" }] }),
    /automation_private_event_requires_closed_conversation/u);
  assert.equal(f.appended.length, 0);
});
