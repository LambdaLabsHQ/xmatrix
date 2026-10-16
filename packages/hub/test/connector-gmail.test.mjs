import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { GMAIL_ACTIONS as ACTIONS, verifyGmail } from "../src/connectors/actions/gmail.ts";
import { parseActionCommand } from "../src/connectors/action-parse.ts";
import { exchangeOAuthGrant, oauthAuthorizeUrl, oauthClient } from "../src/connectors/oauth.ts";
import { deleteComposioAccount } from "../src/connectors/composio.ts";
import { agentMailboxOwner, mayUseMailbox, parseMailboxes } from "../src/connectors/gmail-mailboxes.ts";
import { grantFieldsForgottenOnDisconnect } from "../src/connectors/oauth.ts";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { getAppConnectorProvider } from "../src/app-connectors.ts";
import { verifyGitHubAppState } from "../src/index-shared.ts";
import * as metering from "../src/usage-cost-metering.ts";

const composio = { CONNECTOR_GMAIL_CLIENT_ID: "ac_gmailreadonly", CONNECTOR_COMPOSIO_API_KEY: "composio-project-key" };
const mailbox = { account: "ca_mailbox1", address: "me@example.com", owner: "user:user-1" };
const token = { mailboxes: JSON.stringify([mailbox]), composioApiKey: "composio-project-key" };
const ctx = { credentials: token, caller: { userId: "user-1" } };
const base64url = value => Buffer.from(value).toString("base64url");
/* Composio's proxy wraps the Gmail answer. */
const gmail = (data, status = 200) => ({ body: { status, data } });
const proxied = call => ({ endpoint: call.body.endpoint, query: call.body.parameters.map(({ name, value }) => `${name}=${value}`).join("&") });

const statement = body => {
  const command = parseActionCommand("gmail", body);
  return ACTIONS[command.actionId].parse(command.statement);
};

test("Connect signs in through Composio as a per-attempt user and stores only the account it confirms", async () => {
  assert.equal(oauthClient({}, "gmail"), undefined);
  const client = oauthClient(composio, "gmail");
  const started = await fetched([{ body: { redirect_url: "https://connect.composio.dev/link/lk_1", connected_account_id: "ca_x" } }],
    () => oauthAuthorizeUrl(client, { spaceId: "space-1", userId: "user-1", redirectUri: "https://hub.test/api/connectors/oauth/callback" }));
  assert.equal(started.result, "https://connect.composio.dev/link/lk_1");
  const link = started.calls[0];
  assert.equal(link.url, "https://backend.composio.dev/api/v3.1/connected_accounts/link");
  assert.equal(link.headers.get("x-api-key"), "composio-project-key");
  const callback = new URL(link.body.callback_url);
  assert.equal(callback.origin + callback.pathname, "https://hub.test/api/connectors/oauth/callback");
  const state = callback.searchParams.get("state");
  const claims = await verifyGitHubAppState(state, "composio-project-key");
  assert.deepEqual([link.body.auth_config_id, link.body.user_id], ["ac_gmailreadonly", `xmatrix:space-1:${claims.nonce}`]);

  const account = { id: "ca_mailbox1", status: "ACTIVE", auth_config: { id: "ac_gmailreadonly" } };
  const exchanged = await fetched([{ body: { items: [account] } }], () => exchangeOAuthGrant(client, "", "https://hub.test/cb", state));
  assert.deepEqual(exchanged.result.fields, { mailboxes: "ca_mailbox1" });
  const lookup = new URL(exchanged.calls[0].url);
  assert.deepEqual([lookup.searchParams.get("user_ids"), lookup.searchParams.get("auth_config_ids"), lookup.searchParams.get("statuses")],
    [`xmatrix:space-1:${claims.nonce}`, "ac_gmailreadonly", "ACTIVE"]);
  for (const items of [[], [account, { ...account, id: "ca_other" }], [{ ...account, auth_config: { id: "ac_other" } }]]) {
    await fetched([{ body: { items } }], () => assert.rejects(exchangeOAuthGrant(client, "", "https://hub.test/cb", state), /did not confirm/u));
  }
  await assert.rejects(exchangeOAuthGrant(client, "", "https://hub.test/cb", `${state}x`), /restart Connect/u);
  const manifest = getAppConnectorProvider("gmail");
  assert.deepEqual(manifest.auth.scopes, ["https://mail.google.com/"]);
  for (const [id, action] of Object.entries(ACTIONS)) {
    const entry = manifest.actions.find(candidate => candidate.id === id);
    const write = id === "send" || id === "reply";
    assert.deepEqual([action.effect, entry?.effect, entry?.defaultPolicy],
      write ? ["write", "write", "ask"] : ["read", "read", undefined], id);
  }
});

test("statements are validated before any request", () => {
  assert.deepEqual(statement("@gmail:search:* from:noreply@example.com newer_than:1h"), { query: "from:noreply@example.com newer_than:1h", mailbox: "" });
  assert.deepEqual(statement("@gmail:search:*"), { query: "", mailbox: "" });
  assert.deepEqual(statement("@gmail:search:ops@example.com is:unread"), { query: "is:unread", mailbox: "ops@example.com" });
  assert.deepEqual(statement("@gmail:send:ops@example.com from:me@example.com Weekly\nAll green."),
    { to: "ops@example.com", from: "me@example.com", subject: "Weekly", body: "All green." });
  assert.deepEqual(statement("@gmail:read:18f2a9c0d1e2b3a4"), { id: "18f2a9c0d1e2b3a4" });
  assert.deepEqual(statement("@gmail:send:ops@example.com Weekly report\nAll green."),
    { to: "ops@example.com", from: "", subject: "Weekly report", body: "All green." });
  assert.deepEqual(statement("@gmail:reply:18f2a9c0d1e2b3a4 Thanks,\nreceived."), { id: "18f2a9c0d1e2b3a4", body: "Thanks,\nreceived." });
  for (const bad of ["@gmail:send:not-an-address Hi", "@gmail:send:a@b.test,c@d.test Hi", "@gmail:send:ops@example.com",
    "@gmail:reply:18f2a9c0d1e2b3a4", "@gmail:reply:../send hi"]) {
    assert.equal(typeof statement(bad), "string", bad);
  }
  for (const bad of ["@gmail:search:inbox", `@gmail:search:* ${"x".repeat(501)}`, "@gmail:read:../profile", "@gmail:read:18f2a9c0d1e2b3a4 extra"]) {
    assert.equal(typeof statement(bad), "string", bad);
  }
});

test("search lists the newest matches with their metadata", async () => {
  const search = await fetched([
    gmail({ messages: [{ id: "18f2a9c0d1e2b3a4" }, { id: "bad/id" }] }),
    gmail({ id: "18f2a9c0d1e2b3a4", internalDate: String(Date.UTC(2026, 9, 9, 20)), snippet: "Confirm your email &amp; start",
      payload: { headers: [{ name: "From", value: "Acme <noreply@acme.test>" }, { name: "Subject", value: "Verify\nyour email" }] } }),
  ], () => ACTIONS.search.execute(ctx, { query: "from:acme.test" }));
  assert.equal(search.calls[0].url, "https://backend.composio.dev/api/v3.1/tools/execute/proxy");
  assert.deepEqual([search.calls[0].body.connected_account_id, search.calls[0].body.method, search.calls[0].headers.get("x-api-key")],
    ["ca_mailbox1", "GET", "composio-project-key"]);
  assert.deepEqual(search.calls.map(proxied), [
    { endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages", query: "maxResults=10&q=from:acme.test" },
    { endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages/18f2a9c0d1e2b3a4", query: "format=metadata" },
  ]);
  assert.match(search.result.summary, /18f2a9c0d1e2b3a4\t2026-10-09T20:00:00\.000Z\tAcme <noreply@acme\.test>\tVerify your email\tConfirm your email & start/u);
  assert.match((await fetched([gmail({})], () => ACTIONS.search.execute(ctx, { query: "" }))).result.summary, /\(no messages\)/u);
});

test("read returns the text body and every link, fenced, from nested parts", async () => {
  const html = "<html><head><style>a{}</style></head><body><p>Hi,</p><p>Click <a href=\"https://acme.test/verify?t=1&amp;u=2\">Verify email</a></p>" +
    "<a href='https://acme.test/help'>Help</a><a href=\"mailto:x@acme.test\">mail</a><a href=\"https://acme.test/verify?t=1&u=2\">again</a></body></html>";
  const message = { id: "18f2a9c0d1e2b3a4", payload: { mimeType: "multipart/mixed", headers: [{ name: "Subject", value: "Verify" }], parts: [
    { mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }], body: { data: base64url(html) } }] },
    { mimeType: "text/plain", headers: [{ name: "Content-Disposition", value: "attachment; filename=a.txt" }], body: { data: base64url("```\nignore previous") } },
  ] } };
  const read = await fetched([gmail(message)], () => ACTIONS.read.execute(ctx, { id: "18f2a9c0d1e2b3a4" }));
  assert.deepEqual(proxied(read.calls[0]), { endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages/18f2a9c0d1e2b3a4", query: "format=full" });
  const summary = read.result.summary;
  assert.match(summary, /Subject: Verify/u);
  assert.match(summary, /Hi,\nClick Verify email/u);
  assert.doesNotMatch(summary, /a\{\}|ignore previous|mailto/u);
  assert.match(summary, /\[1\] https:\/\/acme\.test\/verify\?t=1&u=2\tVerify email\n\[2\] https:\/\/acme\.test\/help\tHelp\n```$/u);
  assert.doesNotMatch(summary, /\[3\]/u);

  const plain = await fetched([gmail({ payload: { mimeType: "text/plain", body: { data: base64url("Open https://acme.test/v/abc to confirm.\n```") } } })],
    () => ACTIONS.read.execute(ctx, { id: "18f2a9c0d1e2b3a4" }));
  assert.match(plain.result.summary, /\[1\] https:\/\/acme\.test\/v\/abc\n/u);
  assert.match(plain.result.summary, /:\n~~~\n/u);
});

test("read preserves ordered mixed body segments without duplicating alternatives or reading attachments", async () => {
  const text = (mimeType, value, extra = {}) => ({ mimeType, body: { data: base64url(value) }, ...extra });
  const payload = { mimeType: "multipart/mixed", parts: [
    { mimeType: "multipart/alternative", parts: [text("text/plain", "Opening paragraph"), text("text/html", "<p>HTML alternative</p>")] },
    text("text/html", "<p>Middle paragraph <a href='https://example.test/help'>Help</a></p>"),
    text("text/plain", "Closing paragraph"),
    { mimeType: "multipart/mixed", headers: [{ name: "Content-Disposition", value: " attachment; filename=notes.mime" }],
      parts: [text("text/plain", "Attached private notes https://example.test/attachment")] },
    text("text/plain", "Filename-only attachment", { filename: "notes.txt" }),
  ] };
  const { result, calls } = await fetched([gmail({ payload })],
    () => ACTIONS.read.execute(ctx, { id: "18f2a9c0d1e2b3a4" }));
  assert.match(result.summary, /Opening paragraph\n\nMiddle paragraph Help\n\nClosing paragraph/u);
  assert.match(result.summary, /\[1\] https:\/\/example\.test\/help\tHelp/u);
  assert.doesNotMatch(result.summary, /HTML alternative|Attached private notes|Filename-only attachment|example\.test\/attachment/u);
  assert.equal(calls.length, 1);
});

test("read keeps all HTML body segments and marks the existing body preview limit", async () => {
  const payload = { mimeType: "multipart/mixed", parts: [
    { mimeType: "text/html", body: { data: base64url("<p>First paragraph</p>") } },
    { mimeType: "text/html", body: { data: base64url("<p>Second paragraph</p>") } },
  ] };
  const { result } = await fetched([gmail({ payload })],
    () => ACTIONS.read.execute(ctx, { id: "18f2a9c0d1e2b3a4" }));
  assert.match(result.summary, /First paragraph\n\nSecond paragraph/u);
  const { result: long } = await fetched([gmail({ payload: { mimeType: "text/plain", body: { data: base64url("a".repeat(8_001)) } } })],
    () => ACTIONS.read.execute(ctx, { id: "18f2a9c0d1e2b3a4" }));
  assert.match(long.summary, /a{8000}\n… \(body truncated\)/u);
  assert.doesNotMatch(long.summary, /a{8001}/u);
});

test("read reports unavailable inline bodies and MIME limits without fetching external parts", async () => {
  for (const payload of [
    { mimeType: "text/plain", body: { attachmentId: "synthetic-body", size: 100 } },
    { mimeType: "multipart/mixed", parts: Array.from({ length: 201 }, (_, index) =>
      ({ mimeType: "text/plain", body: { data: base64url(`Paragraph ${index}`) } })) },
  ]) {
    const { result, calls } = await fetched([gmail({ payload })],
      () => ACTIONS.read.execute(ctx, { id: "18f2a9c0d1e2b3a4" }));
    assert.match(result.summary, /some body parts unavailable or omitted at the MIME part limit/u);
    assert.doesNotMatch(result.summary, /Paragraph 199|Paragraph 200/u);
    assert.equal(calls.length, 1);
  }
});

test("Gmail fails closed without its Composio account, on Gmail refusals and on bad data", async () => {
  await assert.rejects(ACTIONS.search.execute({ credentials: { composioApiKey: "composio-project-key" }, caller: { userId: "user-1" } }, { query: "" }), /Connect a Gmail mailbox/u);
  await assert.rejects(ACTIONS.search.execute({ credentials: { mailboxes: "[{" }, caller: { userId: "user-1" } }, { query: "" }), /unreadable/u);
  await assert.rejects(ACTIONS.search.execute({ credentials: { mailboxes: token.mailboxes }, caller: { userId: "user-1" } }, { query: "" }), /Composio is not configured/u);
  await assert.rejects(ACTIONS.search.execute({ credentials: token }, { query: "" }), /who is asking/u);
  await fetched([gmail({ error: { message: "Requested entity was not found." } }, 404)],
    () => assert.rejects(ACTIONS.read.execute(ctx, { id: "18f2a9c0d1e2b3a4" }), /none of your Gmail mailboxes has message/u));
  await fetched([{ body: { data: {} } }], () => assert.rejects(verifyGmail(token), /provider's answer/u));
  await fetched([gmail({ messages: {} })], () => assert.rejects(ACTIONS.search.execute(ctx, { query: "" }), /message list/u));
  await fetched([gmail({})], () => assert.rejects(ACTIONS.read.execute(ctx, { id: "18f2a9c0d1e2b3a4" }), /Gmail message/u));
  await fetched([gmail({})], () => assert.rejects(verifyGmail(token), /confirm Gmail/u));
  await fetched([gmail({ emailAddress: "me@example.com" })], () => verifyGmail(token));
});

test("Disconnect deletes the Composio account, treating one already gone as deleted", async () => {
  const deleted = await fetched([{ body: { success: true } }], () => deleteComposioAccount("composio-project-key", "ca_mailbox1"));
  assert.equal(deleted.calls[0].url, "https://backend.composio.dev/api/v3.1/connected_accounts/ca_mailbox1");
  assert.equal(deleted.calls[0].method, "DELETE");
  assert.equal(deleted.calls[0].headers.get("x-api-key"), "composio-project-key");
  await fetched([{ status: 404, body: { error: { message: "not found" } } }], () => deleteComposioAccount("composio-project-key", "ca_mailbox1"));
  await fetched([{ status: 500, body: {} }], () => assert.rejects(deleteComposioAccount("composio-project-key", "ca_mailbox1")));
  const skipped = await fetched([], () => deleteComposioAccount("composio-project-key", "../x"));
  assert.deepEqual(skipped.calls, []);
});

test("forgetting a Gmail grant deletes the Composio account before clearing the stored id", async () => {
  const load = await compileCommonJsSourceModule(new URL("../src/connectors/forget-grant.ts", import.meta.url));
  const effects = [];
  const repository = {
    resolveForAdmin: async () => ({ version: 1, connectionVersion: 2, connectionGeneration: "generation",
      values: { mailboxes: JSON.stringify([mailbox, { ...mailbox, account: "ca_mailbox2", address: "two@example.com" }]) } }),
    put: async (input) => { effects.push(["put", input.providerId, input.fields]); },
  };
  const dependencies = {
    "../app-connectors": { getAppConnectorProvider },
    "./composio": { deleteComposioAccount: async (key, id) => { effects.push(["delete", key, id]); } },
    "./gmail-mailboxes": { parseMailboxes },
    "./credentials": { connectorCredentialRepository: () => repository },
    "./oauth": { grantFieldsForgottenOnDisconnect, oauthClient },
    "../usage-cost-metering": metering,
  };
  const { forgetConnectionGrant } = load(name => { assert.ok(dependencies[name], name); return dependencies[name]; }, { crypto, Date, Object });
  const input = { spaceId: "space-1", actorUserId: "admin" };
  await forgetConnectionGrant(composio, { ...input, providerId: "gmail" });
  await forgetConnectionGrant(composio, { ...input, providerId: "gcp" });
  await forgetConnectionGrant(composio, { ...input, providerId: "notion" });
  assert.deepEqual(effects, [
    ["delete", "composio-project-key", "ca_mailbox1"],
    ["delete", "composio-project-key", "ca_mailbox2"],
    ["put", "gmail", { mailboxes: null }],
    ["put", "gcp", { oauthToken: null, oauthRefreshToken: null, oauthExpiresAt: null }],
  ]);
});

const decodedRaw = raw => Buffer.from(raw, "base64url").toString("utf8");

test("send posts one plain-text message to messages/send, the only write endpoint", async () => {
  const sent = await fetched([gmail({ id: "19a0b1c2d3e4f5a6" })],
    () => ACTIONS.send.execute(ctx, { to: "ops@example.com", subject: "Bericht für\r\nBcc: x@evil.test", body: "Zeile 1\nZeile 2" }));
  const call = sent.calls[0];
  assert.deepEqual([call.body.method, call.body.endpoint, call.body.parameters],
    ["POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", undefined]);
  const raw = decodedRaw(call.body.body.raw);
  assert.match(raw, /^To: ops@example\.com\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\nMIME-Version: 1\.0\r\n/u);
  assert.doesNotMatch(raw, /\r\nBcc:/u);
  assert.equal(Buffer.from(raw.match(/=\?UTF-8\?B\?([^?]+)\?=/u)[1], "base64").toString(), "Bericht für Bcc: x@evil.test");
  assert.equal(Buffer.from(raw.split("\r\n\r\n")[1], "base64").toString(), "Zeile 1\r\nZeile 2");
  assert.equal(sent.result.summary, "Sent Gmail message 19a0b1c2d3e4f5a6 from me@example.com to ops@example.com.");
});

test("reply answers the sender in the original thread", async () => {
  const original = gmail({ id: "18f2a9c0d1e2b3a4", threadId: "18f2a9c0d1e2b300", payload: { headers: [
    { name: "From", value: "Acme <noreply@acme.test>" }, { name: "Reply-To", value: "Support <help@acme.test>" },
    { name: "Subject", value: "Your ticket" }, { name: "Message-ID", value: "<m1@acme.test>" }, { name: "References", value: "<m0@acme.test>" }] } });
  const replied = await fetched([original, gmail({ id: "19a0b1c2d3e4f5a7" })],
    () => ACTIONS.reply.execute(ctx, { id: "18f2a9c0d1e2b3a4", body: "Thanks" }));
  assert.deepEqual(proxied(replied.calls[0]), { endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages/18f2a9c0d1e2b3a4",
    query: "format=metadata" });
  const post = replied.calls[1].body;
  assert.deepEqual([post.method, post.endpoint, post.body.threadId], ["POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", "18f2a9c0d1e2b300"]);
  assert.match(decodedRaw(post.body.raw), /^To: help@acme\.test\r\nSubject: Re: Your ticket\r\nIn-Reply-To: <m1@acme\.test>\r\nReferences: <m0@acme\.test> <m1@acme\.test>\r\n/u);
  assert.equal(replied.result.summary, "Replied to Gmail message 18f2a9c0d1e2b3a4 from me@example.com as 19a0b1c2d3e4f5a7, to help@acme.test.");
  const noAddress = gmail({ payload: { headers: [{ name: "From", value: "Mailer Daemon" }] } });
  await fetched([noAddress], () => assert.rejects(ACTIONS.reply.execute(ctx, { id: "18f2a9c0d1e2b3a4", body: "x" }), /no address/u));
});

test("the Hub calls no Gmail endpoint outside its list, whatever the grant allows", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../src/connectors/actions/gmail.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /composio(Get|Post)\(credentials, `\$\{API\}/u, "every Gmail call goes through gmailPath");
  assert.equal((source.match(/composioPost\(/gu) ?? []).length, 1, "one write call site");
  const blocked = await fetched([], () => assert.rejects(ACTIONS.read.execute(ctx, { id: "../../settings" }), /does not call Gmail GET/u));
  assert.deepEqual(blocked.calls, []);
});

const agentKey = { ownerUserId: "user-2", machineId: "machine-1", harness: "claude" };
const two = [mailbox, { account: "ca_mailbox2", address: "bot@example.com", owner: agentMailboxOwner(agentKey) },
  { account: "ca_mailbox3", address: "other@example.com", owner: "user:user-3" }];
const shared = { mailboxes: JSON.stringify(two), composioApiKey: "composio-project-key" };

test("a mailbox serves only its owner: the member and their Agents, or the one Agent registration", () => {
  assert.equal(mayUseMailbox(two[0], { userId: "user-1" }), true);
  assert.equal(mayUseMailbox(two[0], { userId: "user-1", agent: { ...agentKey, ownerUserId: "user-1" } }), true);
  assert.equal(mayUseMailbox(two[0], { userId: "user-2" }), false);
  assert.equal(mayUseMailbox(two[1], { userId: "user-2" }), false, "the Agent's owner is not the Agent");
  assert.equal(mayUseMailbox(two[1], { userId: "user-2", agent: agentKey }), true);
  assert.equal(mayUseMailbox(two[1], { userId: "user-2", agent: { ...agentKey, machineId: "machine-2" } }), false);
  assert.equal(agentMailboxOwner({ ownerUserId: "u/1", machineId: "m 1", harness: "claude" }), "agent:u%2F1/m%201/claude");
});

test("actions use only the caller's mailboxes, and search labels each one", async () => {
  const human = { credentials: shared, caller: { userId: "user-1" } };
  const agent = { credentials: shared, caller: { userId: "user-2", agent: async () => agentKey } };
  const searched = await fetched([gmail({ messages: [] })], () => ACTIONS.search.execute(human, { query: "", mailbox: "" }));
  assert.deepEqual(searched.calls.map(call => call.body.connected_account_id), ["ca_mailbox1"]);
  await fetched([], () => assert.rejects(ACTIONS.search.execute(human, { query: "", mailbox: "bot@example.com" }), /not a connected Gmail mailbox you may use/u));
  await fetched([], () => assert.rejects(ACTIONS.search.execute({ credentials: shared, caller: { userId: "user-9" } }, { query: "" }), /no connected Gmail mailbox belongs to you/u));
  await fetched([], () => assert.rejects(ACTIONS.search.execute({ credentials: shared, caller: { userId: "user-2", agent: async () => undefined } }, { query: "" }), /no longer authorizes/u));
  const both = { credentials: { ...shared, mailboxes: JSON.stringify([two[0], { ...two[1], owner: "user:user-1" }]) }, caller: { userId: "user-1" } };
  const listed = await fetched([gmail({ messages: [{ id: "18f2a9c0d1e2b3a4" }] }), gmail({ messages: [] }), gmail({ id: "18f2a9c0d1e2b3a4", payload: { headers: [] } })],
    () => ACTIONS.search.execute(both, { query: "", mailbox: "" }));
  assert.match(listed.result.summary, /\(mailbox, id, received UTC/u);
  assert.match(listed.result.summary, /me@example\.com\t18f2a9c0d1e2b3a4/u);
  const read = await fetched([gmail({ error: { message: "Requested entity was not found." } }, 404),
    gmail({ id: "18f2a9c0d1e2b3a4", payload: { mimeType: "text/plain", body: { data: base64url("hi") } } })],
  () => ACTIONS.read.execute(both, { id: "18f2a9c0d1e2b3a4" }));
  assert.deepEqual(read.calls.map(call => call.body.connected_account_id), ["ca_mailbox1", "ca_mailbox2"]);
  assert.match(read.result.summary, /Mailbox: bot@example\.com/u);
  await fetched([], () => assert.rejects(ACTIONS.send.execute(both, { to: "x@example.com", from: "", subject: "s", body: "" }), /name the sending mailbox/u));
  const sent = await fetched([gmail({ id: "19a0b1c2d3e4f5a6" })], () => ACTIONS.send.execute(agent, { to: "x@example.com", from: "", subject: "s", body: "" }));
  assert.deepEqual([sent.calls[0].body.connected_account_id, sent.result.summary], ["ca_mailbox2", "Sent Gmail message 19a0b1c2d3e4f5a6 from bot@example.com to x@example.com."]);
});

test("Check reads every mailbox's profile", async () => {
  const checked = await fetched([gmail({ emailAddress: "me@example.com" }), gmail({ emailAddress: "bot@example.com" }), gmail({ emailAddress: "other@example.com" })],
    () => verifyGmail(shared));
  assert.deepEqual(checked.calls.map(call => call.body.connected_account_id), ["ca_mailbox1", "ca_mailbox2", "ca_mailbox3"]);
});

test("Connect adds a mailbox: a repeat replaces its account and keeps its owner, and the list is bounded", async () => {
  const load = await compileCommonJsSourceModule(new URL("../src/connectors/gmail-mailboxes.ts", import.meta.url));
  let stored = [{ ...mailbox, owner: "user:user-7" }, { account: "ca_mailbox2", address: "two@example.com", owner: "user:user-1" }];
  const deleted = [];
  const profiles = { ca_new1: "ME@example.com", ca_new2: "three@example.com" };
  const http = await import("../src/connectors/http.ts");
  const dependencies = {
    "./composio": {
      composioGet: async (credentials) => ({ emailAddress: profiles[credentials.composioAccountId] }),
      deleteComposioAccount: async (_key, id) => { deleted.push(id); },
    },
    "./credentials": { connectorCredentialRepository: () => ({
      resolveForAdmin: async () => ({ values: { mailboxes: JSON.stringify(stored) } }) }) },
    "./http": http,
    "./oauth": { oauthClient: () => ({ clientSecret: "composio-project-key" }) },
    "../usage-cost-metering": metering,
  };
  const { addConnectedMailbox } = load(name => { assert.ok(dependencies[name], name); return dependencies[name]; },
    { crypto, Date, Object, JSON, encodeURIComponent });
  const input = { spaceId: "space-1", actorUserId: "user-1" };
  const again = JSON.parse((await addConnectedMailbox({}, { ...input, account: "ca_new1" })).mailboxes);
  assert.deepEqual(again, [stored[1], { account: "ca_new1", address: "me@example.com", owner: "user:user-7" }]);
  assert.deepEqual(deleted, ["ca_mailbox1"]);
  const added = JSON.parse((await addConnectedMailbox({}, { ...input, account: "ca_new2" })).mailboxes);
  assert.deepEqual(added.at(-1), { account: "ca_new2", address: "three@example.com", owner: "user:user-1" });
  stored = Array.from({ length: 10 }, (_, index) => ({ account: `ca_full${index}`, address: `m${index}@example.com`, owner: "user:user-1" }));
  await assert.rejects(addConnectedMailbox({}, { ...input, account: "ca_new2" }), /at most 10/u);
  assert.equal(deleted.at(-1), "ca_new2");
});

// Approval must show the actual reply destination and hold it stable: a later metadata
// fetch must not silently redirect an approved email. The provider tests above do not freeze it.
test("approval freezes reply headers before any send and revalidates the mailbox before writing", async () => {
  const original = gmail({ id: "18f2a9c0d1e2b3a4", threadId: "18f2a9c0d1e2b300", payload: { headers: [
    { name: "From", value: "Sender <sender@example.test>" }, { name: "Reply-To", value: "Approved <approved@example.test>" },
    { name: "Subject", value: "Frozen subject" }, { name: "Message-ID", value: "<frozen@example.test>" }] } });
  const staged = await fetched([original], () => ACTIONS.reply.prepare(ctx, { id: "18f2a9c0d1e2b3a4", body: "Approved body" }));
  assert.equal(staged.calls.length, 1);
  assert.equal(staged.calls[0].body.method, "GET", "preparing never sends");
  const frozen = staged.result;
  assert.deepEqual([frozen.from, frozen.to, frozen.subject, frozen.body],
    ["me@example.com", "approved@example.test", "Re: Frozen subject", "Approved body"]);
  let checks = 0;
  const sent = await fetched([gmail({ id: "19a0b1c2d3e4f5a6" })], () => ACTIONS.reply.execute({ ...ctx,
    authorizeWrite: async () => { checks++; } }, frozen));
  assert.equal(checks, 1, "policy is checked immediately before the write");
  assert.equal(sent.calls.length, 1, "sending the approved reply never resolves new headers");
  assert.match(decodedRaw(sent.calls[0].body.body.raw), /^To: approved@example\.test\r\nSubject: Re: Frozen subject\r\n/u);
  const changed = { ...ctx, credentials: { ...ctx.credentials,
    mailboxes: JSON.stringify([{ ...mailbox, account: "ca_reconnected" }]) } };
  const blocked = await fetched([], () => assert.rejects(ACTIONS.reply.execute(changed, frozen), /mailbox changed/));
  assert.deepEqual(blocked.calls, []);
  const revoked = await fetched([], () => assert.rejects(ACTIONS.reply.execute({ ...ctx,
    authorizeWrite: async () => { throw new Error("disallowed now"); } }, frozen), /disallowed now/));
  assert.deepEqual(revoked.calls, []);
});
