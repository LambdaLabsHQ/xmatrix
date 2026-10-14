import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";

const {
  AGENT_TURN_FAILURE_LIFECYCLE_LAYER,
  AGENT_TURN_FAILURE_LIFECYCLE_REASON,
  AGENT_TURN_FAILURE_LIFECYCLE_STATUS,
  agentTurnFailureNoticeBody,
  agentUsageLimitFromError,
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

test("Hub reads a usage limit from the original provider error, never a plain rate limit", () => {
  for (const error of [
    "You've hit your usage limit. Upgrade to Pro or try again at 3:04 PM.",
    "You've hit your limit · resets 7pm (America/Los_Angeles)",
    "5-hour limit reached ∙ resets 3pm",
    "error_during_execution: usage_limit_reached",
    "{\"codexErrorInfo\":\"usageLimitExceeded\"}",
    "429 insufficient_quota: You exceeded your current quota",
    "Quota exceeded for quota metric 'Generate Content API requests'",
    `${"context ".repeat(200)}You've hit your weekly limit`,
  ]) assert.ok(agentUsageLimitFromError(error), error);
  for (const error of [
    "Claude API error 429 (rate_limit_error); retry 3/10 in 8s",
    "Rate limit reached for requests",
    "Overloaded",
    "Codex app-server turn failed: stream disconnected before completion",
    "context window limit reached",
    "",
    undefined,
  ]) assert.equal(agentUsageLimitFromError(error), undefined, String(error));
  assert.deepEqual(agentUsageLimitFromError("Claude AI usage limit reached|1790000000"), { resetsAt: "2026-09-21T14:13:20Z" });
});
