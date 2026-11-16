import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentInstanceUnregisterIsTerminal,
} from "../src/runtime-transport/agent-instance-unregister.ts";

test("ordinary Agent unregister remains terminal", () => {
  assert.equal(agentInstanceUnregisterIsTerminal({ routedAs: "agent_mention" }), true);
});

test("daemon-launched Run leaves completion to its exact spawn exit report", () => {
  assert.equal(agentInstanceUnregisterIsTerminal({ routedAs: "agent_mention_spawn",
    spawnControlId: "spawn-control" }), false);
  assert.equal(agentInstanceUnregisterIsTerminal({ routedAs: "agent_mention_spawn" }), true);
  assert.equal(agentInstanceUnregisterIsTerminal({ spawnControlId: " " }), true);
});
