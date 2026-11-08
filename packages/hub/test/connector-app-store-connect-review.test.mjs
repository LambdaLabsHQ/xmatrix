import assert from "node:assert/strict";
import { test } from "node:test";

import { webSession } from "../src/connectors/app-store-connect-web.ts";
import { ACTIONS, apps, BUNDLE, credentials, statement, withApple, writes } from "./support/app-store-connect-double.mjs";

const keys = { ...credentials, webSession: "myacinfo=private-session" };
const thread = { type: "resolutionCenterThreads", id: "thread-1", attributes: { threadType: "REJECTION_REVIEW_SUBMISSION" } };
const root = "/iris/v1";
const threads = `${root}/apps/6760000001/resolutionCenterThreads`;
const messagePath = `${root}/resolutionCenterThreads/thread-1/resolutionCenterMessages`;
const draftPath = `${root}/resolutionCenterThreads/thread-1/resolutionCenterDraftMessage`;
const draft = (body = "The video capture fix is ready.", attachments = []) => ({ type: "resolutionCenterDraftMessages", id: "draft-1",
  attributes: { messageBody: body }, relationships: { resolutionCenterMessageAttachments: { data: attachments.map(({ id, type }) => ({ id, type })) } } });
const attachment = (id, url = "https://apple-assets.s3.amazonaws.com/report.ips?signature=capability") => ({
  type: "resolutionCenterMessageAttachments", id, attributes: { fileName: "report.ips", fileSize: 123,
    assetDeliveryState: "COMPLETE", sourceFileChecksum: "file-checksum", downloadUrl: url, assetToken: "never-print" } });
const routes = () => ({ ...apps, [`GET ${threads}`]: { data: [thread] }, [`GET ${messagePath}`]: { data: [] },
  [`GET ${root}/reviewRejections`]: { data: [] }, [`GET ${draftPath}`]: { data: null } });
const run = (action, input, provider, extra = {}) => withApple(provider, () => ACTIONS[action].execute({ credentials: keys, ...extra }, { app: BUNDLE, ...input }));
const readDraft = async (row, included = []) => {
  const read = await run("review_draft", { thread: thread.id }, { ...routes(), [`GET ${draftPath}`]: { data: row, included } });
  return read.value.summary.match(/digest ([a-f0-9]{64})/u)[1];
};

test("App Review attachments are linked to their app and thread; lists omit signed URLs and asset tokens", async () => {
  const file = attachment("file-1"), rejection = { ...attachment("file-2"), type: "rejectionAttachments" };
  const provider = { ...routes(), [`GET ${messagePath}`]: { data: [{ type: "resolutionCenterMessages", id: "message-1",
    attributes: { messageBody: "Please fix recording." }, relationships: { resolutionCenterMessageAttachments: { data: [{ type: file.type, id: file.id }] } } }],
    included: [file, attachment("unrelated-file")] }, [`GET ${root}/reviewRejections`]: { data: [{ type: "reviewRejections", id: "rejection-1",
    relationships: { rejectionAttachments: { data: [{ type: rejection.type, id: rejection.id }] } } }], included: [rejection] } };
  const listed = await run("review_attachments", {}, provider);
  assert.match(listed.value.summary, /file-1/u);
  assert.match(listed.value.summary, /file-2/u);
  assert.doesNotMatch(listed.value.summary, /signature|never-print|unrelated-file/u);
  const read = await run("review_messages", {}, provider);
  assert.match(read.value.summary, /thread id: thread-1/u);
  assert.match(read.value.summary, /message id: message-1/u);
  const downloaded = await run("review_attachment", { thread: thread.id, id: file.id }, provider);
  assert.equal(downloaded.value.url, file.attributes.downloadUrl);
  assert.ok(downloaded.calls.every(call => call.origin !== "https://apple-assets.s3.amazonaws.com"), "the download is a scoped URL, not a credentialed Hub fetch");
  assert.ok(downloaded.calls.filter(call => call.path.startsWith(root)).every(call => call.cookie === keys.webSession && call.authorization === null));
  await assert.rejects(run("review_attachment", { thread: "another-app-thread", id: file.id }, provider), /does not belong/u);
  await assert.rejects(run("review_attachment", { thread: thread.id, id: "unrelated-file" }, provider), /absent or ambiguous/u);
});

test("attachments Apple links under another type name or leaves out of included are still listed and downloadable", async () => {
  const file = { ...attachment("crash-1"), type: "reviewRejectionAttachments" };
  const provider = { ...routes(), [`GET ${messagePath}`]: { data: [{ type: "resolutionCenterMessages", id: "message-1",
    relationships: { resolutionCenterMessageAttachments: { data: [{ type: "resolutionCenterMessageAttachments", id: "shot-1" }] } } }] },
    [`GET ${root}/reviewRejections`]: { data: [{ type: "reviewRejections", id: "rejection-1",
      relationships: { rejectionAttachments: { data: [{ type: file.type, id: file.id }] } } }] },
    [`GET ${root}/reviewRejectionAttachments/crash-1`]: { data: file } };
  const listed = await run("review_attachments", {}, provider);
  assert.match(listed.value.summary, /crash-1/u);
  assert.match(listed.value.summary, /shot-1/u);
  const downloaded = await run("review_attachment", { thread: thread.id, id: file.id }, provider);
  assert.equal(downloaded.value.url, file.attributes.downloadUrl);
  await assert.rejects(run("review_attachment", { thread: thread.id, id: "shot-1" }, { ...provider,
    [`GET ${root}/resolutionCenterMessageAttachments/shot-1`]: { data: attachment("someone-else") } }), /allowed download URL/u);
});

test("attachment capabilities reject foreign origins, credentials, unsafe ports and URL lookalikes", async () => {
  for (const url of ["http://apple.com/log", "https://evil.test/log", "https://apple.com.evil.test/log", "https://user:secret@apple.com/log",
    "https://localhost/log", "https://apple.com:8443/log", "https://apple.com/log#fragment"]) {
    const file = attachment("file-1", url);
    const provider = { ...routes(), [`GET ${messagePath}`]: { data: [{ type: "resolutionCenterMessages", id: "m",
      relationships: { resolutionCenterMessageAttachments: { data: [{ type: file.type, id: file.id }] } } }], included: [file] } };
    await assert.rejects(run("review_attachment", { thread: thread.id, id: file.id }, provider), /allowed download URL/u);
  }
  for (const command of [`@appstoreconnect:review_attachment:${BUNDLE} .. file-1`, `@appstoreconnect:send_review_draft:${BUNDLE} thread-1 draft-1 invalid`]) {
    assert.equal(typeof statement(command), "string", "invalid references fail parsing before Apple is called");
  }
});

test("ownership pagination follows only the app relationship and preserves filters", async () => {
  let pages = 0;
  const next = `https://appstoreconnect.apple.com${threads}?filter[threadType]=REJECTION_BINARY,REJECTION_METADATA,REJECTION_REVIEW_SUBMISSION,APP_MESSAGE_ARC,APP_MESSAGE_ARB,APP_MESSAGE_COMM,APP_MESSAGE_INFORMATIONAL&page=2`;
  const read = await run("review_draft", { thread: thread.id }, { ...routes(), [`GET ${threads}`]: () => ++pages === 1
    ? { data: [], links: { next } } : { data: [thread] } });
  assert.match(read.value.summary, /no unsent draft/u);
  assert.equal(pages, 2);
  for (const next of ["https://evil.test/page", `https://appstoreconnect.apple.com${root}/resolutionCenterThreads`,
    `https://appstoreconnect.apple.com${threads}?page=2`, 42]) {
    await assert.rejects(run("review_draft", { thread: thread.id }, { ...routes(), [`GET ${threads}`]: { data: [], links: { next } } }), /review page/u);
  }
});

test("creating a draft never overwrites an existing or malformed draft, and verifies the created body", async () => {
  let current = null;
  const message = "A reply with Unicode 中文 and\nnew lines.";
  const provider = { ...routes(), [`GET ${draftPath}`]: () => ({ data: current }),
    [`POST ${root}/resolutionCenterDraftMessages`]: call => {
      assert.equal(call.body.relationships.resolutionCenterThread.data.id, thread.id);
      current = draft(call.body.attributes.messageBody);
      return { data: current };
    } };
  const created = await run("edit_review_draft", { thread: thread.id, operation: "create", message }, provider);
  assert.match(created.value.summary, /Saved unsent.*digest [a-f0-9]{64}/u);
  assert.equal(current.attributes.messageBody, message);
  assert.deepEqual(writes(created.calls), [`POST ${root}/resolutionCenterDraftMessages`]);
  await assert.rejects(run("edit_review_draft", { thread: thread.id, operation: "create", message }, provider), /already has an unsent draft/u);
  for (const malformed of [{}, { data: {} }, { data: { type: "wrong", id: "id" } }]) {
    const refused = await withApple({ ...routes(), [`GET ${draftPath}`]: malformed }, async () => {
      await assert.rejects(ACTIONS.edit_review_draft.execute({ credentials: keys }, { app: BUNDLE, thread: thread.id, operation: "create", message }), /malformed/u);
    });
    assert.deepEqual(writes(refused.calls), []);
  }
});

test("draft updates and deletes require an exact current snapshot; failed verification never claims success", async () => {
  let current = draft();
  const digest = await readDraft(current);
  const provider = { ...routes(), [`GET ${draftPath}`]: () => ({ data: current }),
    [`PATCH ${root}/resolutionCenterDraftMessages/draft-1`]: call => {
      current = draft(call.body.attributes.messageBody); return { data: current };
    }, [`DELETE ${root}/resolutionCenterDraftMessages/draft-1`]: () => { current = null; return null; } };
  const updated = await run("edit_review_draft", { thread: thread.id, id: "draft-1", digest, operation: "update", message: "Updated reply" }, provider);
  assert.match(updated.value.summary, /Saved unsent/u);
  const stale = await withApple(provider, async () => {
    await assert.rejects(ACTIONS.edit_review_draft.execute({ credentials: keys }, { app: BUNDLE, thread: thread.id, id: "draft-1", digest, operation: "delete" }), /changed/u);
  });
  assert.deepEqual(writes(stale.calls), []);
  const nextDigest = updated.value.summary.match(/digest ([a-f0-9]{64})/u)[1];
  const deleted = await run("edit_review_draft", { thread: thread.id, id: "draft-1", digest: nextDigest, operation: "delete" }, provider);
  assert.match(deleted.value.summary, /Deleted unsent/u);
  assert.equal(current, null);
});

test("sending checks body and attachment snapshot, verifies the new thread message, and cannot replay a consumed draft", async () => {
  const file = attachment("file-1");
  file.attributes.assetDeliveryState = { state: "COMPLETE", errors: [] };
  let current = draft("Ready for review", [file]), sent = [], sends = 0;
  const digest = await readDraft(current, [file]);
  const provider = { ...routes(), [`GET ${draftPath}`]: () => ({ data: current, included: [file] }),
    [`GET ${messagePath}`]: () => ({ data: sent }), [`POST ${root}/resolutionCenterMessages`]: call => {
      sends++; assert.equal(call.body.relationships.createFromDraftMessage.data.id, "draft-1");
      sent = [{ type: "resolutionCenterMessages", id: "sent-1", attributes: { messageBody: current.attributes.messageBody } }];
      current = null; return { data: sent[0] };
    } };
  const input = { thread: thread.id, id: "draft-1", digest };
  const accepted = await run("send_review_draft", input, provider);
  assert.match(accepted.value.summary, /Sent App Review reply sent-1.*verified in the thread/u);
  await assert.rejects(run("send_review_draft", input, provider), /absent or changed/u);
  assert.equal(sends, 1);
  current = draft("Ready for review", [file]);
  file.attributes.sourceFileChecksum = "changed-file";
  await assert.rejects(run("send_review_draft", input, provider), /absent or changed/u);
  assert.equal(sends, 1);
});

test("an ambiguous send is never retried, and pending attachments cannot be sent", async () => {
  const file = attachment("file-1"); file.attributes.assetDeliveryState = "UPLOAD_COMPLETE";
  const current = draft("Reply", [file]), digest = await readDraft(current, [file]);
  let sends = 0;
  const provider = { ...routes(), [`GET ${draftPath}`]: { data: current, included: [file] },
    [`POST ${root}/resolutionCenterMessages`]: () => { sends++; return { status: 503, errors: [{ detail: "Try later" }] }; } };
  await assert.rejects(run("send_review_draft", { thread: thread.id, id: "draft-1", digest }, provider), /not processed/u);
  assert.equal(sends, 0);
  file.attributes.assetDeliveryState = "COMPLETE";
  await assert.rejects(run("send_review_draft", { thread: thread.id, id: "draft-1", digest: await readDraft(current, [file]) }, provider), /503/u);
  assert.equal(sends, 1);
});

test("every web mutation revalidates current app write permission immediately before fetch", async () => {
  let checks = 0;
  const denied = await withApple({ [`POST ${root}/resolutionCenterMessages`]: {} }, async () => {
    const session = webSession({ credentials: keys, authorizeWrite: async () => { checks++; throw new Error("permission was revoked"); } });
    await assert.rejects(session.send("POST", `${root}/resolutionCenterMessages`, {}), /permission was revoked/u);
  });
  assert.equal(checks, 1);
  assert.deepEqual(denied.calls, []);
});

test("oversized website responses are cancelled while streaming rather than fully buffered", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; } });
  const read = await withApple({ [`GET ${root}/reviewRejections`]: new Response(stream) }, async () => {
    await assert.rejects(webSession({ credentials: keys }).read(`${root}/reviewRejections`), /size limit/u);
  });
  assert.equal(read.calls.length, 1);
  assert.equal(cancelled, true);
});
