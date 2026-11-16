import assert from "node:assert/strict";
import test from "node:test";

import { activityMessageKind, isAgentContextMessage, isChannelActivity } from "../dist/index.js";

test("an activity entry is one by its provenance, whoever writes it, and its kind follows", () => {
  const following = { xmatrixProvenance: "activity", xmatrixGitHubPullRequest: { repository: "o/r", number: 7 } };
  assert.equal(isChannelActivity(following), true);
  // An App that asks for no kind, or for the text kind, still appends an activity entry: never unread, never a summon.
  assert.equal(activityMessageKind(undefined, following), "xmatrix.activity");
  assert.equal(activityMessageKind("xmatrix.message.text", following), "xmatrix.activity");
  assert.equal(activityMessageKind("xmatrix.system.norn-request", { xmatrixProvenance: "system_fact" }), "xmatrix.system.norn-request");
  assert.equal(activityMessageKind(undefined, undefined), undefined);
});

test("facts and activity entries are context for Agents; anything else is not", () => {
  assert.equal(isAgentContextMessage({ xmatrixProvenance: "system_fact" }), true);
  assert.equal(isAgentContextMessage({ xmatrixProvenance: "activity" }), true);
  for (const metadata of [undefined, null, [], {}, { xmatrixProvenance: "approved_action_result" }]) {
    assert.equal(isAgentContextMessage(metadata), false, JSON.stringify(metadata));
  }
});
