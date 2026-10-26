import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";

const { connectorReceiptBody, connectorReceiptPreview, parseConnectorReceipt } =
  await loadTypescriptModule(new URL("../src/connector-receipt.ts", import.meta.url));

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
