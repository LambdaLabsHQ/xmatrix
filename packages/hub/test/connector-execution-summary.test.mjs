import assert from "node:assert/strict";
import { test } from "node:test";
import * as protocol from "@xmatrix/protocol";
import { appRequestFields } from "../../db/src/app-control.ts";
import { SENTRY_ACTIONS } from "../src/connectors/actions/sentry.ts";
import { loadCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { stubFetchResponses } from "./support/fetch-responses.mjs";

async function execute(outcome) {
  const commands = [];
  const support = await loadCommonJsSourceModule(new URL("../src/connectors/command-support.ts", import.meta.url), name => {
    if (name === "@xmatrix/protocol") return protocol;
    if (name === "../apps") return {
      async appCommand(_env, command, input) {
        commands.push({ command, input });
        if (command === "finalize-execution") {
          if (input.resultSummary !== undefined) appRequestFields.text(input.resultSummary, "resultSummary", 1000);
          if (input.reason !== undefined) appRequestFields.text(input.reason, "reason", 500);
        }
        return { ok: true };
      },
    };
    if (["../product-message-append", "../private-response",
      "../spaces"].includes(name)) return {};
    assert.fail(`unexpected import: ${name}`);
  });
  let attempts = 0;
  const result = await support.withExecution({ id: "sentry", name: "Sentry" },
    { messageId: "read-fixture", channelId: "channel", actorUserId: "human" },
    { authority: {}, principal: { kind: "user", id: "human" }, connectionId: "connection" },
    { id: "read_issue", label: "Read issue", key: "" }, async () => { attempts++; return outcome; });
  assert.equal(attempts, 1);
  assert.deepEqual(commands.map(c => c.command), ["record-execution", "finalize-execution"]);
  assert.equal(commands[1].input.expectedVersion, 1);
  return { result, finalized: commands[1].input };
}

test("a Sentry read with multibyte stack metadata finalizes and returns the entire context", async () => {
  const stub = stubFetchResponses([
    { body: { id: "123", shortId: "APP-1", title: "测试应用错误", status: "unresolved" } },
    { body: { groupID: "123", eventID: "a".repeat(32), entries: [{ type: "exception", data: {
      values: [{ type: "Error", value: "真实错误🙂".repeat(180), stacktrace: {
        frames: [{ filename: "应用.ts", function: "处理", lineNo: 42 }],
      } }],
    } }] } },
  ]);
  let summary;
  try {
    ({ summary } = await SENTRY_ACTIONS.read_issue.execute({ credentials: {
      authToken: "fixture-token", organization: "test-org",
    } }, { issue: "123" }));
  } finally { stub.restore(); }
  assert.throws(() => appRequestFields.text(summary.slice(0, 1000), "resultSummary", 1000), /invalid/);
  const { finalized, result } = await execute({ status: "completed", summary });
  assert.equal(finalized.status, "completed");
  assert.equal(finalized.resultChannelId, "channel");
  assert.ok(Buffer.byteLength(finalized.resultSummary) <= 1000);
  assert.ok(summary.startsWith(finalized.resultSummary));
  assert.ok(!finalized.resultSummary.includes("\ufffd"));
  assert.ok(result.includes(summary), "persisted excerpt does not truncate the tool's context");
});

test("failed and blocked multibyte reasons respect the existing 500-byte authority bound", async () => {
  for (const status of ["failed", "blocked"]) {
    const summary = "  " + "Provider unavailable · 🙂拒绝".repeat(80) + "  ";
    const { result, finalized } = await execute({ status, summary });
    assert.equal(finalized.status, status);
    assert.equal(finalized.resultSummary, undefined);
    assert.equal(finalized.resultChannelId, undefined);
    assert.ok(Buffer.byteLength(finalized.reason) <= 500);
    assert.ok(summary.trim().startsWith(finalized.reason));
    assert.ok(!finalized.reason.includes("\ufffd"));
    assert.ok(result.includes(summary));
  }
});

test("short ASCII completion summaries remain unchanged", async () => {
  const summary = "Marked APP-1 resolved";
  const { finalized } = await execute({ status: "completed", summary });
  assert.equal(finalized.resultSummary, summary);
});
