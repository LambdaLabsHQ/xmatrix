import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { GMAIL_ACTIONS as ACTIONS, gmailPreview } from "../src/connectors/actions/gmail.ts";
import { createMailAttachments } from "../src/connectors/gmail-attachments.ts";

const mailbox = { account: "ca_mailbox1", address: "me@example.com", owner: "user:user-1" };
const token = { mailboxes: JSON.stringify([mailbox]), composioApiKey: "composio-project-key" };
const gmail = (data, status = 200) => ({ body: { status, data } });
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/* Two Channel files on the command message, read through a fake attachment authority and bucket. */
function channelFiles(files) {
  const state = { files: files.map(file => ({ ...file, version: 1 })), authority: [], denied: false };
  const attachments = createMailAttachments({ channelId: "channel-1", actorUserId: "user-1",
    sources: state.files.map(file => ({ messageId: "command-1", attachmentId: file.id })),
    async attachmentAuthority(request) {
      state.authority.push(request);
      const file = state.files.find(candidate => candidate.id === request.attachmentId);
      if (state.denied || !file) return Response.json({ error: "attachment denied" }, { status: 403 });
      const hash = sha256(file.bytes);
      return Response.json({ channelId: request.channelId, messageId: request.messageId, visibilityScopeId: "space:space-1",
        attachment: { id: file.id, name: file.name, mimeType: file.mimeType, size: file.bytes.length, version: file.version },
        object: { checksum: hash, contentHash: hash, encodedBytes: file.bytes.length, objectKey: `objects/${hash}` } });
    },
    bucket: { async get(key) {
      const file = state.files.find(candidate => `objects/${sha256(candidate.bytes)}` === key);
      if (!file) return null;
      const bytes = state.served?.(file) ?? file.bytes;
      return { body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
        size: file.bytes.length, customMetadata: { sha256: sha256(file.bytes) }, checksums: {}, etag: "immutable" };
    } },
  });
  return { state, attachments };
}

function staging() {
  const staged = [];
  return { staged, mailSnapshot: { async stage(bytes, contentType) {
    const entry = { bytes, contentType, removed: 0 };
    staged.push(entry);
    return { url: "https://hub.test/api/connectors/mail-snapshots/token-1", remove: async () => { entry.removed++; } };
  } } };
}

/* The message/rfc822 part of a staged upload, and its MIME parts split at the multipart/mixed boundary. */
function uploaded(entry) {
  const outer = entry.contentType.match(/^multipart\/related; boundary=(\S+)$/u)[1];
  const body = Buffer.from(entry.bytes).toString("latin1");
  const [, metadata, message] = body.split(`--${outer}`);
  const mime = message.replace(/^\r\nContent-Type: message\/rfc822\r\n\r\n/u, "").replace(/\r\n$/u, "");
  const inner = mime.match(/boundary="([^"]+)"/u)[1];
  const [headers, ...rest] = mime.split(`\r\n--${inner}`);
  const parts = rest.slice(0, -1).map(part => {
    const [head, content] = part.replace(/^\r?\n/u, "").split("\r\n\r\n");
    return { head, content: Buffer.from(content.replace(/\r\n/gu, ""), "base64") };
  });
  assert.equal(rest.at(-1), "--\r\n", "the multipart ends with its closing boundary");
  return { metadata: JSON.parse(metadata.split("\r\n\r\n")[1]), headers, parts };
}

const pdf = { id: "file-1", name: "report.pdf", mimeType: "application/pdf",
  bytes: new Uint8Array(200_000).map((_, index) => (index * 7) % 256) };
const photo = { id: "file-2", name: "报价 2026.jpg", mimeType: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) };

test("send freezes the command's files on the card, then mails them as attachments through the upload endpoint", async () => {
  const { state, attachments } = channelFiles([pdf, photo]);
  const { staged, mailSnapshot } = staging();
  const ctx = { credentials: token, caller: { userId: "user-1" }, mailAttachments: attachments };
  const frozen = await ACTIONS.send.prepare(ctx, { to: "ops@example.com", from: "", subject: "Quarterly", body: "See attached." });
  assert.deepEqual(gmailPreview(frozen), { from: "me@example.com", to: "ops@example.com", subject: "Quarterly", body: "See attached.",
    attachments: "2: report.pdf (200000 bytes); 报价 2026.jpg (7 bytes)" }, "the card lists every file the send carries");
  for (const call of state.authority) {
    assert.deepEqual(call, { channelId: "channel-1", messageId: "command-1", attachmentId: call.attachmentId,
      principal: { kind: "user", id: "user-1" } }, "files are read as the Human through this Channel's authority");
  }
  let checks = 0;
  const sent = await fetched([gmail({ id: "19a0b1c2d3e4f5a6" })],
    () => ACTIONS.send.execute({ ...ctx, mailSnapshot, authorizeWrite: async () => { checks++; } }, frozen));
  assert.equal(checks, 1);
  const post = sent.calls[0].body;
  assert.deepEqual([post.method, post.endpoint, post.parameters, post.body],
    ["POST", "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send",
      [{ name: "uploadType", value: "multipart", type: "query" }], undefined]);
  assert.deepEqual(post.binary_body, { url: "https://hub.test/api/connectors/mail-snapshots/token-1", content_type: staged[0].contentType });
  assert.equal(staged[0].removed, 1, "the staged message is deleted once the send ends");
  const { metadata, headers, parts } = uploaded(staged[0]);
  assert.deepEqual(metadata, {});
  assert.match(headers, /^To: ops@example\.com\r\nSubject: Quarterly\r\nMIME-Version: 1\.0\r\nContent-Type: multipart\/mixed; boundary="xmatrix-[0-9a-f-]+"\r\n$/u);
  assert.equal(parts.length, 3);
  assert.match(parts[0].head, /^Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64$/u);
  assert.equal(parts[0].content.toString(), "See attached.");
  assert.equal(parts[1].head, 'Content-Type: application/pdf; name="report.pdf"\r\n' +
    'Content-Disposition: attachment; filename="report.pdf"\r\nContent-Transfer-Encoding: base64');
  assert.deepEqual(new Uint8Array(parts[1].content), pdf.bytes, "the file's exact bytes are attached");
  assert.match(parts[2].head, /^Content-Type: image\/jpeg; name="=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?="\r\nContent-Disposition: attachment; filename="=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?="; filename\*=UTF-8''%E6%8A%A5%E4%BB%B7%202026\.jpg\r\n/u);
  assert.deepEqual(new Uint8Array(parts[2].content), photo.bytes);
  assert.equal(sent.result.summary, "Sent Gmail message 19a0b1c2d3e4f5a6 from me@example.com to ops@example.com with attachments " +
    "2: report.pdf (200000 bytes); 报价 2026.jpg (7 bytes).");
});

test("reply carries the command's files in the original thread", async () => {
  const { attachments } = channelFiles([pdf]);
  const { staged, mailSnapshot } = staging();
  const ctx = { credentials: token, caller: { userId: "user-1" }, mailAttachments: attachments, mailSnapshot };
  const original = gmail({ id: "18f2a9c0d1e2b3a4", threadId: "18f2a9c0d1e2b300", payload: { headers: [
    { name: "From", value: "Acme <help@acme.test>" }, { name: "Subject", value: "Your ticket" }, { name: "Message-ID", value: "<m1@acme.test>" }] } });
  const replied = await fetched([original, gmail({ id: "19a0b1c2d3e4f5a7" })],
    () => ACTIONS.reply.execute(ctx, { id: "18f2a9c0d1e2b3a4", body: "Logs attached" }));
  assert.equal(replied.calls[1].body.endpoint, "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send");
  const { metadata, headers, parts } = uploaded(staged[0]);
  assert.deepEqual(metadata, { threadId: "18f2a9c0d1e2b300" });
  assert.match(headers, /^To: help@acme\.test\r\nSubject: Re: Your ticket\r\nIn-Reply-To: <m1@acme\.test>\r\nReferences: <m1@acme\.test>\r\n/u);
  assert.deepEqual(new Uint8Array(parts[1].content), pdf.bytes);
  assert.match(replied.result.summary, /as 19a0b1c2d3e4f5a7, to help@acme\.test with attachments 1: report\.pdf \(200000 bytes\)\.$/u);
});

test("a file changed, withdrawn or unreadable after approval is not sent, and nothing reaches Gmail", async () => {
  const ctx = (attachments, extra = {}) => ({ credentials: token, caller: { userId: "user-1" }, mailAttachments: attachments, ...extra });
  const input = { to: "ops@example.com", from: "", subject: "Quarterly", body: "See attached." };
  const changed = channelFiles([pdf]);
  const frozen = await ACTIONS.send.prepare(ctx(changed.attachments), input);
  changed.state.files[0].version = 2;
  let posted = await fetched([], () => assert.rejects(ACTIONS.send.execute(ctx(changed.attachments, staging()), frozen), /report\.pdf changed after it was approved/u));
  assert.deepEqual(posted.calls, []);
  const denied = channelFiles([pdf]);
  denied.state.denied = true;
  posted = await fetched([], () => assert.rejects(ACTIONS.send.execute(ctx(denied.attachments, staging()), frozen), /no longer available to you/u));
  assert.deepEqual(posted.calls, []);
  const corrupt = channelFiles([pdf]);
  corrupt.state.served = file => file.bytes.map(byte => byte ^ 1);
  posted = await fetched([], () => assert.rejects(ACTIONS.send.execute(ctx(corrupt.attachments, staging()), frozen), /changed after it was approved/u));
  assert.deepEqual(posted.calls, []);
  posted = await fetched([], () => assert.rejects(ACTIONS.send.execute(ctx(channelFiles([pdf]).attachments), frozen), /no staging for Gmail attachments/u));
  assert.deepEqual(posted.calls, [], "without staging nothing is posted");
  posted = await fetched([], () => assert.rejects(ACTIONS.send.execute(ctx(undefined, staging()), frozen), /cannot read Channel attachments/u));
  assert.deepEqual(posted.calls, []);
  await assert.rejects(ACTIONS.send.execute(ctx(undefined), { ...frozen, attachmentFiles: "[]" }), /approved attachments are incomplete/u);
});

test("a send refuses more files or bytes than Gmail carries before any approval, and attaches none without files", async () => {
  const ctx = attachments => ({ credentials: token, caller: { userId: "user-1" }, mailAttachments: attachments });
  const input = { to: "ops@example.com", from: "", subject: "Quarterly", body: "See attached." };
  const many = channelFiles(Array.from({ length: 21 }, (_, index) => ({ ...photo, id: `file-${index}`, name: `p${index}.jpg` })));
  await assert.rejects(ACTIONS.send.prepare(ctx(many.attachments), input), /at most 20 files/u);
  assert.deepEqual(many.state.authority, [], "an oversized list reads no file");
  const big = new Uint8Array(13 * 1024 * 1024);
  const large = channelFiles([{ ...pdf, bytes: big }, { ...pdf, id: "file-9", bytes: big.map(() => 1) }]);
  await assert.rejects(ACTIONS.send.prepare(ctx(large.attachments), input), /at most 25 MiB of attachments/u);
  const unattached = await ACTIONS.send.prepare(ctx(undefined), input);
  assert.equal(unattached.attachments, undefined);
  assert.equal(unattached.attachmentFiles, undefined);
  const noStorage = createMailAttachments({ channelId: "channel-1", actorUserId: "user-1",
    sources: [{ messageId: "command-1", attachmentId: "file-1" }], attachmentAuthority: async () => Response.json({}), bucket: undefined });
  await assert.rejects(ACTIONS.send.prepare(ctx(noStorage), input), /cannot read Channel attachments/u,
    "a file on the command is never dropped silently");
});
