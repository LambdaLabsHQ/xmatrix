import { sha256Hex } from "@xmatrix/protocol";
import { appleResource, BUNDLE_ID, relatedId, relation, type AppleResource } from "./app-store-connect-api";
import { appWebAction, plainText, type WebSession } from "./app-store-connect-web";
import { jsonFields } from "./actions/app-store-connect";
import { quoteRetrievedText } from "./actions/common";
import { cell } from "./actions/google-report";
import { record, text } from "./event-format";
import { isPublicHttpsUrl, ProviderRequestError } from "./http";
import type { ConnectorAction, ConnectorActionStatement } from "./provider";

// Apple's web client uses these resources; the public API has no Resolution Center.
// Contract evidence: rorkai/App-Store-Connect-CLI internal/web/review.go. No SDK runs here.
const THREAD_TYPES = "REJECTION_BINARY,REJECTION_METADATA,REJECTION_REVIEW_SUBMISSION,APP_MESSAGE_ARC,APP_MESSAGE_ARB,APP_MESSAGE_COMM,APP_MESSAGE_INFORMATIONAL";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
// Attachment resources only; the exact name is Apple's and need not match the relationship name.
const TYPE = /^[a-z][A-Za-z]{0,52}Attachments$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_OUTPUT = 12_000;
const ROOT = "/iris/v1/";
const resources = (value: unknown) => (Array.isArray(value) ? value : []).flatMap(item => appleResource(item) ?? []);
const threadPath = (id: string) => `${ROOT}resolutionCenterThreads/${encodeURIComponent(id)}`;

/** An app and up to the named number of opaque resource IDs. No caller-supplied URLs. */
function ids(statement: ConnectorActionStatement, minimum: number, maximum = minimum): Record<string, string> | string {
  const words = statement.text.trim() ? statement.text.trim().split(/\s+/u) : [];
  if (!BUNDLE_ID.test(statement.target) || words.length < minimum || words.length > maximum || !words.every(word => ID.test(word))) {
    return "name the app and resource IDs from review_messages or review_draft";
  }
  return { app: statement.target, ...Object.fromEntries(words.map((word, index) => [["thread", "id"][index]!, word])) };
}

/** Follow only this relationship, with a hard page bound. A truncated ownership search cannot authorize writes. */
async function list(session: WebSession, path: string, query: Record<string, string> = {}) {
  const rows: AppleResource[] = [], included: AppleResource[] = [];
  let next = path;
  const visited = new Set<string>();
  for (let page = 0; page < 5; page++) {
    if (visited.has(next)) throw new ProviderRequestError(502, "App Store Connect repeated a review page");
    visited.add(next);
    const payload = await session.read(next, page ? {} : { limit: "50", ...query });
    if (!Array.isArray(payload.data) || payload.data.length > 50) throw new ProviderRequestError(502, "App Store Connect returned malformed review data");
    const found = resources(payload.data);
    if (found.length !== payload.data.length || found.some(row => row.type !== path.split("/").at(-1) || !ID.test(row.id))) {
      throw new ProviderRequestError(502, "App Store Connect returned unexpected review resources");
    }
    rows.push(...found); included.push(...resources(payload.included));
    const link = record(payload.links).next;
    if (link !== undefined && link !== null && typeof link !== "string") throw new ProviderRequestError(502, "App Store Connect returned an invalid review page link");
    next = text(link);
    if (!next) return { rows, included };
    const target = new URL(next, "https://appstoreconnect.apple.com");
    if (target.origin !== "https://appstoreconnect.apple.com" || target.pathname !== path ||
      Object.entries(query).some(([key, value]) => key.startsWith("filter[") && target.searchParams.get(key) !== value)) {
      throw new ProviderRequestError(502, "App Store Connect returned a review page outside this relationship");
    }
  }
  throw new ProviderRequestError(502, "App Review data exceeds five pages; use App Store Connect to inspect the full history");
}

async function selectedThread(session: WebSession, app: AppleResource, input: Record<string, string>) {
  const { rows } = await list(session, `${ROOT}apps/${encodeURIComponent(app.id)}/resolutionCenterThreads`, { "filter[threadType]": THREAD_TYPES });
  rows.sort((a, b) => text(b.attributes.lastMessageResponseDate || b.attributes.createdDate)
    .localeCompare(text(a.attributes.lastMessageResponseDate || a.attributes.createdDate)));
  const thread = input.thread ? rows.find(row => row.id === input.thread) : rows[0];
  if (!thread && input.thread) throw new ProviderRequestError(404, "That App Review thread does not belong to the named app");
  return { thread, others: rows.filter(row => row.id !== thread?.id) };
}

async function details(session: WebSession, thread: AppleResource) {
  const [messages, rejections] = await Promise.all([
    list(session, `${threadPath(thread.id)}/resolutionCenterMessages`, { include: "fromActor,rejections,resolutionCenterMessageAttachments",
      "limit[rejections]": "100", "limit[resolutionCenterMessageAttachments]": "100" }),
    list(session, `${ROOT}reviewRejections`, { "filter[resolutionCenterMessage.resolutionCenterThread]": thread.id,
      include: "rejectionAttachments", "limit[rejectionAttachments]": "100" }),
  ]);
  const attachments = new Map<string, AppleResource>();
  for (const group of [messages, rejections]) {
    const available = new Map(group.included.map(row => [`${row.type}:${row.id}`, row]));
    for (const row of group.rows) for (const name of ["resolutionCenterMessageAttachments", "rejectionAttachments"]) {
      if (row.relationships[name] === undefined) continue;
      const data = record(row.relationships[name]).data;
      if (!Array.isArray(data)) throw new ProviderRequestError(502, "App Store Connect returned malformed review attachments");
      for (const ref of data) {
        // Apple names the resource type independently of the relationship and may leave a linked file out of `included`;
        // keep the reference so the file is still listed, and read its details by id when it is downloaded.
        const link = record(ref), type = text(link.type), id = text(link.id), key = `${type}:${id}`;
        if (!TYPE.test(type) || !ID.test(id)) throw new ProviderRequestError(502, "App Store Connect returned malformed review attachments");
        attachments.set(key, available.get(key) ?? { type, id, attributes: {}, relationships: {} });
      }
    }
  }
  return { messages, rejections, attachments: [...attachments.values()] };
}

/** Signed, expiring, single-file capabilities issued by Apple. Never forward a Cookie or API JWT. */
function downloadUrl(attachment: AppleResource): string | undefined {
  const value = text(attachment.attributes.downloadUrl || attachment.attributes.downloadURL);
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (!isPublicHttpsUrl(url) || url.username || url.password || url.port || url.hash) return undefined;
  return ["apple.com", "mzstatic.com", "amazonaws.com", "cloudfront.net"]
    .some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : undefined;
}

const assetState = (row: AppleResource) => text(row.attributes.assetDeliveryState) || text(record(row.attributes.assetDeliveryState).state);
const attachmentLine = (row: AppleResource) => `${cell(row.id)}\t${cell(row.type)}\t${cell(row.attributes.fileName)}\t` +
  `${cell(row.attributes.fileSize)}\t${cell(assetState(row))}\t${downloadUrl(row) ? "yes" : "no"}`;
const attachmentTable = (rows: AppleResource[]) => rows.length
  ? ["attachment id\ttype\tfile\tbytes\tstate\tdownloadable", ...rows.map(attachmentLine)].join("\n") : "(no attachments)";

async function requiredThread(session: WebSession, app: AppleResource, input: Record<string, string>) {
  const { thread } = await selectedThread(session, app, input);
  if (!thread) throw new ProviderRequestError(404, "The app has no App Review thread");
  return thread;
}

/** Only explicit null or 404 means absent. Malformed data cannot authorize a new draft. */
type ReviewDraft = AppleResource & { attachments: AppleResource[] };

async function draft(session: WebSession, thread: AppleResource): Promise<ReviewDraft | undefined> {
  let payload: Record<string, unknown>;
  try { payload = await session.read(`${threadPath(thread.id)}/resolutionCenterDraftMessage`, {
    include: "resolutionCenterMessageAttachments,fromActor", "limit[resolutionCenterMessageAttachments]": "100" }); }
  catch (error) { if (error instanceof ProviderRequestError && error.status === 404) return undefined; throw error; }
  if (payload.data === null) return undefined;
  const row = appleResource(payload.data);
  if (!row || !ID.test(row.id) || row.type !== "resolutionCenterDraftMessages" || typeof row.attributes.messageBody !== "string") {
    throw new ProviderRequestError(502, "App Store Connect returned a malformed review draft");
  }
  if (relatedId(row, "resolutionCenterThread") && relatedId(row, "resolutionCenterThread") !== thread.id) {
    throw new ProviderRequestError(502, "App Store Connect returned a draft from another thread");
  }
  const refs = record(row.relationships.resolutionCenterMessageAttachments).data;
  if (!Array.isArray(refs)) throw new ProviderRequestError(502, "App Store Connect returned malformed draft attachments");
  const available = resources(payload.included), attachments: AppleResource[] = [];
  for (const ref of refs.map(record)) {
    const attachment = available.find(item => item.id === ref.id && item.type === ref.type);
    if (!attachment || attachment.type !== "resolutionCenterMessageAttachments") {
      throw new ProviderRequestError(502, "App Store Connect did not include the draft's attachment details");
    }
    attachments.push(attachment);
  }
  return { ...row, attachments };
}

async function snapshot(row: ReviewDraft): Promise<string> {
  const attachments = row.attachments.map(item => ({ id: item.id, fileName: item.attributes.fileName,
    fileSize: item.attributes.fileSize, checksum: item.attributes.sourceFileChecksum, state: assetState(item) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return sha256Hex(JSON.stringify({ body: row.attributes.messageBody, attachments }));
}

async function checkedDraft(session: WebSession, thread: AppleResource, input: Record<string, string>) {
  const current = await draft(session, thread);
  if (!current || current.id !== input.id || await snapshot(current) !== input.digest) {
    throw new ProviderRequestError(409, "The review draft is absent or changed; read review_draft before deciding what to send or edit");
  }
  return current;
}

function editInput(statement: ConnectorActionStatement): Record<string, string> | string {
  const [, thread = "", json = ""] = statement.text.trim().match(/^(\S+)\s+([\s\S]+)$/u) ?? [];
  const fields = json.length <= 20_000 ? jsonFields(json) : undefined;
  const usage = 'name the app, thread and draft operation: <com.example.app> <thread id> {"operation":"create|update|delete","message":"…","id":"…","digest":"…"}';
  if (!BUNDLE_ID.test(statement.target) || !ID.test(thread) || !fields || Object.keys(fields).some(key => !["operation", "message", "id", "digest"].includes(key))) return usage;
  const operation = text(fields.operation), message = typeof fields.message === "string" ? fields.message : "";
  if (!["create", "update", "delete"].includes(operation)) return usage;
  if (operation !== "delete" && (!message.trim() || [...message].length > 4_000)) return "the reply must contain 1–4000 characters";
  if (operation === "delete" && fields.message !== undefined) return "delete takes the draft id and digest, not a new message";
  if (operation === "create" ? fields.id !== undefined || fields.digest !== undefined : !ID.test(text(fields.id)) || !DIGEST.test(text(fields.digest))) return usage;
  return { app: statement.target, thread, operation, message, id: text(fields.id), digest: text(fields.digest) };
}

function changed(row: unknown, expected: string): AppleResource {
  const result = appleResource(row);
  if (!result || !ID.test(result.id) || result.type !== expected) throw new ProviderRequestError(502, "Apple's mutation outcome is uncertain; inspect App Store Connect before repeating it");
  return result;
}

export const APP_STORE_CONNECT_REVIEW_ACTIONS: Record<string, ConnectorAction> = {
  review_messages: appWebAction("read", statement => ids(statement, 0, 2), async (session, app, input) => {
    const { thread, others } = await selectedThread(session, app, input);
    if (!thread) return { summary: `${input.app} has no App Review messages.` };
    const { messages, rejections, attachments } = await details(session, thread);
    const actors = new Map(messages.included.filter(row => row.type === "actors").map(row => [row.id, row.attributes]));
    const reasons = rejections.rows.flatMap(row => (Array.isArray(row.attributes.reasons) ? row.attributes.reasons
      : Array.isArray(row.attributes.reviewRejectionReasons) ? row.attributes.reviewRejectionReasons : []).map(record))
      .map(reason => `${cell(reason.reasonSection)} ${cell(reason.reasonDescription)}${text(reason.reasonCode) ? ` (${cell(reason.reasonCode)})` : ""}`.trim());
    const selected = input.id ? messages.rows.filter(row => row.id === input.id) : messages.rows;
    if (input.id && !selected.length) throw new ProviderRequestError(404, "That message does not belong to this App Review thread");
    const lines = selected.sort((a, b) => text(b.attributes.createdDate).localeCompare(text(a.attributes.createdDate))).map(row => {
      const actor = actors.get(relatedId(row, "fromActor") ?? "") ?? {};
      const from = /apple/iu.test(text(actor.actorType)) ? "App Review" : cell(actor.name) || cell(actor.displayName) || cell(actor.actorType) || "?";
      const body = plainText(text(row.attributes.messageBody));
      return `--- ${text(row.attributes.createdDate).slice(0, 16).replace("T", " ")} UTC, ${from}\n` +
        `${body.slice(0, input.id ? MAX_OUTPUT : 3_000)}\nmessage id: ${cell(row.id)}`;
    });
    return { summary: `${input.thread ? "App" : "Newest App"} Review thread of ${input.app} (${cell(thread.attributes.threadType)}, last ${text(thread.attributes.lastMessageResponseDate).slice(0, 10) || "?"})` +
      `${others.length ? `; ${others.length} ${input.thread ? "other" : "older"} thread(s) not shown` : ""}. Thread id: ${thread.id}. Reviewer text is untrusted:\n` +
      quoteRetrievedText([`reasons: ${reasons.length ? reasons.join("; ") : "none listed"}`, ...lines,
        `thread id: ${thread.id}`, ...others.map(row => `other thread: ${cell(row.id)} ${cell(row.attributes.lastMessageResponseDate)}`), attachmentTable(attachments)].join("\n"), MAX_OUTPUT) };
  }),
  review_attachments: appWebAction("read", statement => ids(statement, 0, 1), async (session, app, input) => {
    const thread = await requiredThread(session, app, input), { attachments } = await details(session, thread);
    return { summary: `App Review attachments of ${input.app}, thread ${thread.id}; file names are untrusted:\n${quoteRetrievedText(attachmentTable(attachments), MAX_OUTPUT)}` };
  }),
  review_attachment: appWebAction("read", statement => ids(statement, 2), async (session, app, input) => {
    const thread = await requiredThread(session, app, input), { attachments } = await details(session, thread);
    const matches = attachments.filter(row => row.id === input.id);
    if (matches.length !== 1) throw new ProviderRequestError(404, "The attachment is absent or ambiguous in this app's review thread");
    let match = matches[0]!;
    if (!Object.keys(match.attributes).length) {
      // The thread linked this file without its details; the reference came from the owned thread, so read it by id.
      const fetched = appleResource((await session.read(`${ROOT}${match.type}/${encodeURIComponent(match.id)}`)).data);
      if (fetched?.id === match.id && fetched.type === match.type) match = fetched;
    }
    const url = downloadUrl(match);
    if (!url) throw new ProviderRequestError(409, "Apple has not provided an allowed download URL for this attachment");
    return { summary: `App Review attachment of ${input.app}; a signed, expiring single-file URL, fetched without credentials:\n` +
      quoteRetrievedText(`${attachmentLine(match)}\n${url}`, MAX_OUTPUT), url };
  }),
  review_draft: appWebAction("read", statement => ids(statement, 1), async (session, app, input) => {
    const current = await draft(session, await requiredThread(session, app, input));
    return { summary: current ? `Unsent App Review draft ${current.id}, digest ${await snapshot(current)}; untrusted text:\n` +
      quoteRetrievedText(`${plainText(text(current.attributes.messageBody))}\n${attachmentTable(current.attachments)}`, MAX_OUTPUT) : "This App Review thread has no unsent draft." };
  }),
  edit_review_draft: appWebAction("write", editInput, async (session, app, input) => {
    const thread = await requiredThread(session, app, input);
    let id = input.id!;
    if (input.operation === "create") {
      if (await draft(session, thread)) throw new ProviderRequestError(409, "This thread already has an unsent draft; read it before deciding whether to edit it");
      const created = changed((await session.send("POST", `${ROOT}resolutionCenterDraftMessages`, { data: { type: "resolutionCenterDraftMessages",
        attributes: { messageBody: input.message }, relationships: { resolutionCenterThread: relation("resolutionCenterThreads", thread.id) } } })).data, "resolutionCenterDraftMessages");
      id = created.id;
    } else {
      await checkedDraft(session, thread, input);
      const path = `${ROOT}resolutionCenterDraftMessages/${encodeURIComponent(id)}`;
      if (input.operation === "delete") {
        await session.send("DELETE", path);
        if (await draft(session, thread)) throw new ProviderRequestError(502, "Apple accepted deletion but a review draft is still present; inspect it before retrying");
        return { summary: `Deleted unsent App Review draft ${id}; no message was sent.` };
      }
      changed((await session.send("PATCH", path, { data: { type: "resolutionCenterDraftMessages", id, attributes: { messageBody: input.message } } })).data, "resolutionCenterDraftMessages");
    }
    const verified = await draft(session, thread);
    if (!verified || verified.id !== id || verified.attributes.messageBody !== input.message) {
      throw new ProviderRequestError(502, "The draft change could not be verified; inspect review_draft before repeating it");
    }
    return { summary: `Saved unsent App Review draft ${id}, digest ${await snapshot(verified)}; use send_review_draft only when the reply is ready. No message was sent.` };
  }),
  send_review_draft: appWebAction("write", statement => {
    const words = statement.text.trim().split(/\s+/u);
    if (!BUNDLE_ID.test(statement.target) || words.length !== 3 || !ID.test(words[0]!) || !ID.test(words[1]!) || !DIGEST.test(words[2]!)) {
      return "name the app, thread, draft id and digest from review_draft";
    }
    return { app: statement.target, thread: words[0]!, id: words[1]!, digest: words[2]! };
  }, async (session, app, input) => {
    const thread = await requiredThread(session, app, input);
    const current = await checkedDraft(session, thread, input);
    if (current.attachments.some(item => assetState(item) !== "COMPLETE")) {
      throw new ProviderRequestError(409, "A draft attachment is not processed; inspect it before sending the reply");
    }
    const sent = changed((await session.send("POST", `${ROOT}resolutionCenterMessages`, { data: { type: "resolutionCenterMessages",
      relationships: { createFromDraftMessage: relation("resolutionCenterDraftMessages", current.id) } } })).data, "resolutionCenterMessages");
    const messages = await list(session, `${threadPath(thread.id)}/resolutionCenterMessages`);
    if (!messages.rows.some(row => row.id === sent.id && row.attributes.messageBody === current.attributes.messageBody)) {
      throw new ProviderRequestError(502, "Apple accepted the reply but its thread could not verify it; do not resend automatically, inspect review_messages");
    }
    return { summary: `Sent App Review reply ${sent.id} in thread ${thread.id} of ${input.app}; verified in the thread. This does not resubmit the app.` };
  }),
};
