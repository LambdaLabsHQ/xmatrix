import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTextTaskRequest, parseTextTaskResult, TEXT_TASK_INPUT_MAX_BYTES } from "../dist/index.js";

const requestId = "page-summary:00000000-0000-4000-8000-000000000001";
const task = { requestId, presetId: "claude", instruction: "Say how this page stands in one line.", input: "# Plan\n" };

test("a text task names a one-shot harness, an instruction and bounded text", () => {
  assert.deepEqual(parseTextTaskRequest({ ...task, type: "machine_text_task" }), task);
  for (const value of [{ ...task, presetId: "cursor" }, { ...task, instruction: "  " }, { ...task, requestId: "" },
    { ...task, input: "x".repeat(TEXT_TASK_INPUT_MAX_BYTES + 1) }, { ...task, input: 1 }, null]) {
    assert.throws(() => parseTextTaskRequest(value));
  }
});

test("an answer belongs to the harness that was asked, and only a completed one carries text", () => {
  assert.deepEqual(parseTextTaskResult({ presetId: "claude", status: "completed", text: "Ready: 41 of 47" }, task),
    { presetId: "claude", status: "completed", text: "Ready: 41 of 47" });
  assert.deepEqual(parseTextTaskResult({ presetId: "claude", status: "unavailable", reason: "not installed" }, task),
    { presetId: "claude", status: "unavailable", reason: "not installed" });
  for (const value of [{ presetId: "codex", status: "completed", text: "x" }, { presetId: "claude", status: "completed" },
    { presetId: "claude", status: "completed", text: "  " }, { presetId: "claude", status: "failed", text: "x" },
    { presetId: "claude", status: "done" }, { presetId: "claude", status: "failed", token: "x" }]) {
    assert.throws(() => parseTextTaskResult(value, task));
  }
});
