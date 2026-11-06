import assert from "node:assert/strict";
import test from "node:test";
import { CHANNEL_ACTIVITY_MESSAGE_KIND, CHANNEL_ACTIVITY_PROVENANCE, channelActivityLine } from "@xmatrix/protocol";
import { withOutcomes } from "../src/automation-outcomes.ts";
import { prepareRelayV2MessageRecord } from "../src/relay-v2-message-record.ts";
import { base64UrlEncodeBytes } from "../src/relay-v2-primitives.ts";

// What a page's schedules produced (docs/design/pages-live-document.md §6.4).
// The database test proves which facts each occurrence's conversation holds;
// these prove what a listed schedule says about them, reading a pull request
// from the activity entry exactly as the Hub stores it.

/** An activity entry's payload as the Hub stores it (postgres-agent-instance-port.ts appendActivity). */
async function storedActivity(activity) {
  const prepared = await prepareRelayV2MessageRecord({ messageId: "activity:1", channelId: "conversation",
    timelineSequence: 2, senderKind: "agent", senderId: "codex:1", messageKind: CHANNEL_ACTIVITY_MESSAGE_KIND,
    payloadSchemaVersion: 1, entityVersion: 1, sentAt: "2026-11-06T00:00:00.000Z", body: channelActivityLine(activity),
    senderSnapshot: { identityId: "codex:1", label: "codex" },
    residual: { appMetadata: { xmatrixProvenance: CHANNEL_ACTIVITY_PROVENANCE, xmatrixActivity: activity } } });
  return base64UrlEncodeBytes(prepared.payloadBundleBytes);
}

let conversations = 0;
function occurrence(automationId, facts = {}) {
  return { automationId, scheduledFor: "2026-11-06T00:00:00.000Z", status: "dispatched",
    conversationId: `conversation-${++conversations}`, pageChanged: false, launchStates: ["connected"],
    runActive: false, failureNotice: false, activityPayloads: [], ...facts };
}

test("each occurrence says the strongest thing its own conversation records", async () => {
  const pullRequest = await storedActivity({ kind: "pull_request", repository: "acme/api", number: 7,
    url: "https://github.com/acme/api/pull/7" });
  const plan = await storedActivity({ kind: "plan", completed: ["Open a pull request"],
    steps: [{ text: "Open a pull request", status: "completed" }] });
  const facts = {
    audit: [
      occurrence("audit", { launchStates: [] }),
      occurrence("audit", { activityPayloads: [plan, pullRequest], pageChanged: true }),
      occurrence("audit", { activityPayloads: [plan, "not-a-stored-payload"], pageChanged: true }),
      occurrence("audit", { runActive: true }),
      occurrence("audit", { launchStates: ["spawned", "failed"] }),
      occurrence("audit", { launchStates: ["failed", "connected"] }),
      occurrence("audit", { launchStates: ["failed"] }),
      occurrence("audit", { launchStates: [], failureNotice: true }),
      occurrence("audit", { status: "failed", launchStates: [] }),
      occurrence("audit", { launchStates: [] }),
    ],
    reminder: [occurrence("reminder", { launchStates: [] })],
  };
  const asked = [];
  const listed = await withOutcomes({ recentOccurrences: async (input) => {
    asked.push(input.automationIds);
    return input.automationIds.flatMap((id) => facts[id] ?? []);
  } }, "space", [
    { id: "audit", pageId: "page", spaceId: "space", expression: { text: "@codex audit duplication" } },
    { id: "reminder", pageId: "page", spaceId: "space", expression: { text: "Remind Daniel to renew the domain" } },
    { id: "unrun", pageId: "page", spaceId: "space", expression: { text: "@codex sweep" } },
    { id: "elsewhere", pageId: "other-page", spaceId: "other-space" },
    { id: "unpaged", spaceId: "space" },
  ]);
  assert.deepEqual(asked, [["audit", "reminder", "unrun"]], "one read for the Space's page Automations");
  assert.deepEqual(listed[0].outcomes.map((outcome) => outcome.kind), [
    "running", // its line names an Agent that has not been routed yet
    "pull_request", // a pull request outranks the page it also changed
    "page", // a plan and an unreadable entry open no pull request
    "running", "running", // a Run or a launch is still going
    "none", // an Agent started after a failed launch and changed nothing
    "failed_to_start", "failed_to_start", "failed_to_start", // a failed launch, a refused summon, an undelivered occurrence
    "none", // an older occurrence is not waiting for a summon decided long ago
  ]);
  assert.deepEqual(listed[0].outcomes[1], { kind: "pull_request", scheduledFor: "2026-11-06T00:00:00.000Z",
    conversationId: facts.audit[1].conversationId });
  assert.deepEqual(listed[1].outcomes.map((outcome) => outcome.kind), ["none"], "a reminder for a person starts no Agent");
  assert.deepEqual(listed[2].outcomes, [], "a schedule that has not run has no outcomes yet");
  assert.equal("outcomes" in listed[3] || "outcomes" in listed[4], false, "another Space's or a conversation's Automation is not read");
});

test("a Space with more page Automations than one read covers is read in parts", async () => {
  const sizes = [];
  const automations = Array.from({ length: 201 }, (_, index) => ({ id: `a-${index}`, pageId: "page", spaceId: "space" }));
  const listed = await withOutcomes({ recentOccurrences: async ({ automationIds }) => {
    sizes.push(automationIds.length);
    return [];
  } }, "space", automations);
  assert.deepEqual(sizes, [200, 1]);
  assert.equal(listed.every((automation) => Array.isArray(automation.outcomes)), true);
  // The schedules stay listed when what they produced cannot be read.
  const unread = await withOutcomes({ recentOccurrences: async () => { throw new Error("statement timeout"); } },
    "space", automations);
  assert.deepEqual(unread, automations);
});
