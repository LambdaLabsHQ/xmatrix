import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { agentSendSubmissionCanonical } from "../dist/agent-send-submission.js";

const scope = { channelId: "channel:1", messageId: "message:1", agentId: "agent:1", runId: "run:1", instanceId: "instance:1" };
const raw = { body: "@github 中文 😀\n\"reply\"", attachments: [{ attachmentId: "file:1", objectKey: "private/file",
  contentHash: "a".repeat(64), encodedBytes: 123, mimeType: "text/plain", name: "结果.txt" }] };
const hash = value => createHash("sha256").update(agentSendSubmissionCanonical(scope, value)).digest("hex");

test("final intent binds an explicit execution without changing ordinary v1 sends", () => {
  const finalReplyExecutionId = "11111111-1111-4111-8111-111111111111";
  const final = { ...raw, finalReplyExecutionId };
  assert.equal(hash(final), "34c7e469e23fecd5765c687a57cec927cf0c2580907800533addccadf4840137");
  assert.notEqual(hash(final), hash(raw));
  assert.notEqual(hash({ ...final, finalReplyExecutionId: "22222222-2222-4222-8222-222222222222" }), hash(final));
  assert.equal(JSON.parse(agentSendSubmissionCanonical(scope, final))[0], "xmatrix-agent-send-v2");
  assert.equal(JSON.parse(agentSendSubmissionCanonical(scope, final)).at(-1), finalReplyExecutionId);
  for (const id of [null, "", "current", "11111111111141118111111111111111", "AAAAAAAA-1111-4111-8111-111111111111", 123, {}]) {
    assert.equal(agentSendSubmissionCanonical(scope, { ...raw, finalReplyExecutionId: id }), null);
  }
});

test("raw Agent submission matches the Rust Unicode and attachment golden vector", () => {
  assert.equal(hash(raw), "63d4afbc4c67bcf01c33a37bea66778ed469ccd1bda94980b723bea04811fe15");
  assert.equal(hash({ ...raw, senderExecutionKey: "different-secret", senderAgentName: "new label" }), hash(raw));
  for (const field of ["attachmentId", "objectKey", "contentHash", "mimeType", "name"]) {
    assert.notEqual(hash({ ...raw, attachments: [{ ...raw.attachments[0], [field]: "changed" }] }), hash(raw));
  }
  assert.notEqual(hash({ ...raw, body: "different body" }), hash(raw));
});

test("unsupported fields cannot be misrepresented by a partial submission fingerprint", () => {
  for (const extra of [{ replyToMessageId: "message:2" }, { metadata: {} }, { appMentions: [] }]) {
    assert.equal(agentSendSubmissionCanonical(scope, { ...raw, ...extra }), null);
  }
  assert.equal(agentSendSubmissionCanonical(scope, { body: "reply", attachments: [{}] }), null);
  assert.equal(agentSendSubmissionCanonical(scope, { ...raw, attachments: [{ ...raw.attachments[0], presentationResidual: {} }] }), null);
  assert.equal(agentSendSubmissionCanonical(scope, { ...raw, attachments: [{ ...raw.attachments[0], encodedBytes: 1.5 }] }), null);
  assert.equal(hash({ body: "reply" }), hash({ body: "reply", attachments: [] }));
});
