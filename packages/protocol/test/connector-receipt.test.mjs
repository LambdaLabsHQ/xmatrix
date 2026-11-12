import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";

const {
  connectorReceiptAnswersCommandSql, connectorReceiptBody,
  connectorReceiptMessageId, connectorReceiptPreview, parseConnectorReceipt,
} = await loadTypescriptModule(new URL("../src/connector-receipt.ts", import.meta.url));

test("a receipt id is the execution id, including an approval and a finished upload", () => {
  const command = "command-4";
  const app = "gmail";
  assert.equal(connectorReceiptMessageId(command, app), "system:command-4:gmail");
  assert.equal(connectorReceiptMessageId(`${command}:approved`, app), "system:command-4:approved:gmail");
  assert.equal(connectorReceiptMessageId(`${command}:upload-result`, "x"), "system:command-4:upload-result:x");
  assert.equal(connectorReceiptMessageId(`${command}:denied`, app), `system:${command}:denied:${app}`);
  const longCommand = "c".repeat(180);
  const truncated = connectorReceiptMessageId(`${longCommand}:approved`, app);
  assert.equal(truncated.length, 200);
  assert.equal(truncated.startsWith(`system:${longCommand}:approved:`), true);
});

test("the unread check uses the same receipt ids, and a denial stays unread", () => {
  assert.equal(connectorReceiptAnswersCommandSql("m.message_id", "command.message_id", "m.author_id"), [
    "m.message_id=left('system:'||command.message_id||':'||m.author_id,200)",
    "m.message_id=left('system:'||command.message_id||':approved:'||m.author_id,200)",
    "m.message_id=left('system:'||command.message_id||':upload-result:'||m.author_id,200)",
  ].join(" OR "));
});

test("a private call reads as the action's label, its outcome and a private result", () => {
  const body = connectorReceiptBody(["Google Search Console inspect_url: completed; Result: [hidden — private call]."]);
  assert.deepEqual(parseConnectorReceipt(body), [
    { subject: "Inspect URL", status: "completed", detail: "", private: true },
  ]);
});

test("each statement is an entry, and a result spanning lines stays with its statement", () => {
  const body = connectorReceiptBody([
    "GitHub merge: completed; merged #12\nsquash into main.",
    "GitHub subscription: blocked; connect GitHub to this Space first.",
    "Slack: ignored.",
    "Slack refused the change: missing scope",
  ]);
  assert.deepEqual(parseConnectorReceipt(body), [
    { subject: "Merge pull request", status: "completed", detail: "merged #12\nsquash into main", private: false },
    { subject: "GitHub subscription", status: "blocked", detail: "connect GitHub to this Space first", private: false },
    { subject: "Slack", status: "ignored", detail: "", private: false },
    { subject: "", detail: "Slack refused the change: missing scope", private: false },
  ]);
});

test("text that is not a receipt is not read as one", () => {
  assert.equal(parseConnectorReceipt("App connector command status:"), undefined);
  assert.equal(parseConnectorReceipt("Something else:\n- GitHub merge: completed; done."), undefined);
});

test("a conversation row reads a receipt as its first action and outcome, even cut short", () => {
  assert.equal(connectorReceiptPreview("App connector command status: - Google Search Console inspect_url: completed; Result: [hid..."),
    "Inspect URL · Completed");
  assert.equal(connectorReceiptPreview("App connector command status:\n- GitHub merge: failed; x.\n- GitHub subscription: blocked; y."),
    "Merge pull request · Failed");
  assert.equal(connectorReceiptPreview("App connector command status: - Slack refused the change: missing scope"),
    "Slack refused the change: missing scope");
  assert.equal(connectorReceiptPreview("Mail search completed"), undefined);
});

test("receipt previews finish on long whitespace with or without another entry", () => {
  // Exercise the public parser in isolation so quadratic backtracking cannot
  // hang the test runner. The coarse timeout allows ample startup time.
  const loader = new URL("./load-typescript-module.mjs", import.meta.url);
  const source = new URL("../src/connector-receipt.ts", import.meta.url);
  const script = [
    'import assert from "node:assert/strict";',
    "const { loadTypescriptModule } = await import(" + JSON.stringify(loader.href) + ");",
    "const { connectorReceiptPreview } = await loadTypescriptModule(new URL(" + JSON.stringify(source.href) + "));",
    'const first = "App connector command status: - GitHub merge: completed; detail";',
    "const whitespace = String.fromCharCode(9).repeat(1_000_000);",
    'assert.equal(connectorReceiptPreview(first + whitespace + "x"), "Merge pull request · Completed");',
    'assert.equal(connectorReceiptPreview(first + whitespace + "- GitHub merge: failed; next"), "Merge pull request · Completed");',
  ].join("\n");
  execFileSync(process.execPath, ["--input-type=module", "--eval", script], { timeout: 10_000 });
});
