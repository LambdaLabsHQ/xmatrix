import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

const migratedAuthorities = [
  "message-control.ts",
  "message-agent-targets.ts",
  "message-attention-targets.ts",
  "runtime-control.ts",
  "space-secret-control.ts",
  "app-control.ts",
  "scheduler-control.ts",
  "automation-control.ts",
  "trace-access-control.ts",
  "cross-space-read-control.ts",
  "content-control.ts",
  "machine-control.ts",
  "channel-catalog.ts",
  "space-control.ts",
  "user-preferences.ts",
  "channel-stop-fence.ts",
  "page-control.ts",
  "page-conversations.ts",
  // The registration catalog names a registration's running Instances only in
  // Channels the reader may read.
  "agent-registration-control.ts",
  // The visible live-agent list names Channels through
  // channelCapabilityPredicate("catalog_read"), then loads those Instances.
  "channel-agent-presence.ts",
];

const exactOrLifecycleOwnerAuthorities = [
  // Primary DingTalk candidate discovery follows current original-Human inbound
  // authority. Only IDs/version labels are returned; actual effect owners
  // independently enforce source lease and both Humans' Channel capabilities.
  "dingtalk-effect-targets.ts",
  // A Space owner's or admin's connector action policy, after the owner/admin
  // check, joins a Channel only to confirm it belongs to that Space.
  "app-action-policy-control.ts",
  // Candidate discovery is called after the Channel capability gate. This join
  // uses only Channel.space_id to bind model observations to that same Space;
  // it neither returns Channel data nor authorizes an action on the observed Run.
  "agent-registration-run.ts",
  "agent-registration-revocation.ts",
  // A page commit, after the page authority authorized the edit, reconciles
  // that page's Automations; it joins Channels only for their Space.
  "automation-page-anchor.ts",
  "channel-transfer.ts",
  // A Space owner's or admin's one-time move to pages reads every Channel of
  // that Space by design, after the owner/admin check; it returns only the plan.
  "page-migration.ts",
  "runtime-lifecycle-control.ts",
  "runtime-message-executions.ts",
  // Space deletion runs after the owner check, or in the purge worker once the
  // Space has no members. It reads Channels only to locate its own Space's rows.
  "space-deletion.ts",
];

test("every PostgreSQL Channel reader is shared-policy backed or an explicit exact boundary", () => {
  const permitted = new Set([
    "channel-capability-policy.ts", ...migratedAuthorities, ...exactOrLifecycleOwnerAuthorities,
  ]);
  const readers = readdirSync(new URL("../src/", import.meta.url))
    .filter((file) => file.endsWith(".ts") && /data\.channels/u.test(source(file)));
  assert.deepEqual(readers.filter((file) => !permitted.has(file)), []);
});
