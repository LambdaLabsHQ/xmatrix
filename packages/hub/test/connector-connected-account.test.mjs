import assert from "node:assert/strict";
import { test } from "node:test";
import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import { connectedAccount, hasConnectedAccount } from "../src/connectors/connected-account.ts";

test("each provider names the account it reached from one read", async () => {
  const google = await fetched([{ body: { sub: "1", email: "owner@example.com" } }],
    () => connectedAccount("googlesearchconsole", { oauthToken: "g-token" }));
  assert.equal(google.result, "owner@example.com");
  assert.equal(google.calls[0].url, "https://openidconnect.googleapis.com/v1/userinfo");
  assert.equal(google.calls[0].headers.get("authorization"), "Bearer g-token");

  const linear = await fetched([{ body: { data: { organization: { name: "Lambda Labs" } } } }],
    () => connectedAccount("linear", { oauthToken: "l-token" }));
  assert.equal(linear.result, "Lambda Labs");

  const slack = await fetched([{ body: { ok: true, team: "Acme" } }], () => connectedAccount("slack", { botToken: "xoxb-1" }));
  assert.equal(slack.result, "Acme");

  const notion = await fetched([{ body: { bot: { workspace_name: "Docs HQ" } } }],
    () => connectedAccount("notion", { integrationToken: "secret_1" }));
  assert.equal(notion.result, "Docs HQ");

  const bing = await fetched([{ body: { d: [{ Url: "https://a.example/", IsVerified: true }, { Url: "https://b.example/", IsVerified: false },
    { Url: "https://c.example/", IsVerified: true }] } }], () => connectedAccount("bingwebmaster", { apiKey: "0123456789abcdef" }));
  assert.equal(bing.result, "2 verified sites");
});

test("a provider that names nothing, or a failed read, gives no name and never throws", async () => {
  assert.equal(hasConnectedAccount("pagespeed"), false);
  assert.equal(await connectedAccount("pagespeed", { apiKey: "k" }), undefined);
  assert.equal(await connectedAccount("google", {}), undefined, "no token, no read");
  const refused = await fetched([{ status: 401, body: { error: "invalid_token" } }],
    () => connectedAccount("google", { oauthToken: "old" }));
  assert.equal(refused.result, undefined);
  const noEmail = await fetched([{ body: { sub: "1" } }], () => connectedAccount("gcp", { oauthToken: "g" }));
  assert.equal(noEmail.result, undefined, "a grant without the email scope names nobody");
  const long = await fetched([{ body: { ok: true, team: "x".repeat(500) } }], () => connectedAccount("slack", { botToken: "xoxb-1" }));
  assert.equal(long.result.length, 200);
});
