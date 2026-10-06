import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";

const {
  AGENT_TURN_FAILURE_LIFECYCLE_LAYER,
  AGENT_TURN_FAILURE_LIFECYCLE_REASON,
  AGENT_TURN_FAILURE_LIFECYCLE_STATUS,
  agentTurnFailureNoticeBody,
  boundAgentTurnFailureDetail,
  isAgentTurnFailureLifecycle,
  isAgentUsageLimitLifecycle,
} = await loadTypescriptModule(new URL("../src/authority-foundation.ts", import.meta.url));

test("turn_failed is the lifecycle triple Hub treats as a turn-failure notice", () => {
  assert.equal(AGENT_TURN_FAILURE_LIFECYCLE_LAYER, "application");
  assert.equal(AGENT_TURN_FAILURE_LIFECYCLE_STATUS, "failed");
  assert.equal(AGENT_TURN_FAILURE_LIFECYCLE_REASON, "turn_failed");
  assert.equal(
    isAgentTurnFailureLifecycle({
      layer: "application",
      status: "failed",
      reason: "turn_failed",
    }),
    true,
  );
  assert.equal(
    isAgentTurnFailureLifecycle({
      layer: "transport",
      status: "failed",
      reason: "turn_failed",
    }),
    false,
  );
  assert.equal(
    isAgentTurnFailureLifecycle({
      layer: "application",
      status: "failed",
      reason: "app_server_exited",
    }),
    false,
  );
});

test("turn-failure notice copy is Hub-owned and names the agent", () => {
  const notice = agentTurnFailureNoticeBody({
    agentName: "opencode",
    detail: "Internal error: unknown certificate verification error",
  });
  assert.match(notice, /opencode turn/);
  assert.match(notice, /unknown certificate verification error/);
  assert.doesNotMatch(notice, /silently dropping/);
  assert.equal(
    agentTurnFailureNoticeBody({ agentName: "  ", detail: "" }),
    "xMatrix could not complete this agent turn.",
  );
});

test("turn-failure detail is compact and bounded", () => {
  assert.equal(boundAgentTurnFailureDetail("  a\n\nb  "), "a b");
  assert.equal(boundAgentTurnFailureDetail("x".repeat(2000)).length, 600);
});

test("usage_limited is a turn failure that also asks Hub for a handoff", () => {
  const limited = { layer: "application", status: "failed", reason: "usage_limited" };
  assert.equal(isAgentTurnFailureLifecycle(limited), true);
  assert.equal(isAgentUsageLimitLifecycle(limited), true);
  assert.equal(isAgentUsageLimitLifecycle({ ...limited, reason: "turn_failed" }), false);
  assert.equal(isAgentUsageLimitLifecycle({ ...limited, layer: "transport" }), false);
  assert.equal(isAgentUsageLimitLifecycle({ ...limited, status: "blocked" }), false);
});
