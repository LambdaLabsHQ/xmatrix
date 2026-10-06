import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentInstanceUnregisterIsTerminal,
} from "../src/runtime-transport/agent-instance-unregister.ts";

test("scheduled unregister leaves Run terminality to the Machine Daemon exit report", () => {
  assert.equal(agentInstanceUnregisterIsTerminal({
    automationId: "automation-1",
    automationOccurrenceId: "automation-occurrence-1",
  }), false);
});

test("ordinary Agent unregister remains terminal", () => {
  assert.equal(agentInstanceUnregisterIsTerminal({ routedAs: "agent_mention" }), true);
});

test("daemon-launched Run leaves completion to its exact spawn exit report", () => {
  assert.equal(agentInstanceUnregisterIsTerminal({ routedAs: "agent_mention_spawn",
    spawnControlId: "spawn-control" }), false);
  assert.equal(agentInstanceUnregisterIsTerminal({ routedAs: "agent_mention_spawn" }), true);
  assert.equal(agentInstanceUnregisterIsTerminal({ spawnControlId: " " }), true);
});

test("partial scheduled metadata cannot weaken ordinary unregister terminality", () => {
  assert.equal(agentInstanceUnregisterIsTerminal({ automationId: "automation-1" }), true);
  assert.equal(agentInstanceUnregisterIsTerminal({
    automationId: " ",
    automationOccurrenceId: "automation-occurrence-1",
  }), true);
  // 0081 rewrote the pre-rename keys; they no longer identify an Automation Run.
  assert.equal(agentInstanceUnregisterIsTerminal({
    scheduledTaskId: "scheduled-task-1",
    scheduledOccurrenceId: "scheduled-occurrence-1",
  }), true);
});
