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
  // A harness that failed because its own sign-in expired still gets its notice.
  assert.equal(
    isAgentTurnFailureLifecycle({
      layer: "application",
      status: "failed",
      reason: "harness_signed_out",
    }),
    true,
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
  assert.match(agentTurnFailureNoticeBody({ agentName: "  ", detail: "" }), /harness supplied no error detail/u);
  assert.match(agentTurnFailureNoticeBody({ agentName: "  ", detail: "" }), /HTTP status: not reported/u);
});

test("turn-failure detail is compact and bounded", () => {
  assert.equal(boundAgentTurnFailureDetail("  a\n\nb  "), "a b");
  assert.equal(boundAgentTurnFailureDetail("x".repeat(2000)).length, 600);
});

test("all HTTP status classes survive a long error and are not inferred from unlabeled numbers", () => {
  for (let status = 100; status <= 599; status++) {
    const notice = agentTurnFailureNoticeBody({
      agentName: "custom",
      detail: "context ".repeat(100) + "httpStatusCode=" + status + "; requestId=req-123",
    });
    assert.ok(notice.includes("HTTP status: " + status + "."), notice);
    assert.match(notice, /Upstream request: req-123/u);
  }
  const unknown = agentTurnFailureNoticeBody({ agentName: "codex", detail: "workspace routing discovery failed (attempt 403)" });
  assert.match(unknown, /HTTP status: not reported/u);
  assert.doesNotMatch(unknown, /HTTP status: 403/u);
});

test("network, RPC, WebSocket and process evidence stay distinct", () => {
  const notice = (detail) => agentTurnFailureNoticeBody({ agentName: "any-harness", detail });
  assert.match(notice("DNS lookup failed: ENOTFOUND"), /Failure category: dns/u);
  assert.match(notice("unknown certificate verification error"), /Failure category: tls/u);
  assert.match(notice("connection reset by peer"), /Failure category: connection/u);
  assert.match(notice("request timed out"), /Failure category: timeout/u);
  assert.match(notice("code=-32603; Internal error"), /Failure category: rpc/u);
  assert.match(notice("connection closed (WebSocket close code: Some(1006))"), /WebSocket close code: 1006/u);
  assert.match(notice("Headless runtime exited: exit status: 7"), /Process exit code: 7/u);
  assert.match(notice("code=-32603"), /HTTP status: not reported/u);
});

test("shared failure notices remove credentials before bounding and cannot summon an agent", () => {
  const notice = agentTurnFailureNoticeBody({ agentName: "claude", detail:
    "HTTP 403; requestId=req-safe\nAuthorization: Bearer PRIVATE_HEADER\n" +
    'url=https://user:PRIVATE_PASSWORD@example.com/api?token=PRIVATE_QUERY\n{"api_key":"PRIVATE_KEY"}\n' +
    "cause=@auto restart\n/local/private/file" });
  assert.match(notice, /HTTP status: 403/u);
  assert.match(notice, /req-safe/u);
  assert.doesNotMatch(notice, /PRIVATE_|@auto|\/local\/private/u);
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
