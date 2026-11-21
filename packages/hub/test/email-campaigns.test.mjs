import assert from "node:assert/strict";
import { test } from "node:test";

import { unsubscribeToken, unsubscribeUrl } from "../src/index-routes-email-campaigns.ts";
import { feedbackProEmail } from "../src/email-campaign-feedback-pro.ts";
import { agentRunAllowed as allowed } from "./support/agent-run-routes.mjs";

const env = { BETTER_AUTH_SECRET: "s".repeat(40) };

test("an unsubscribe link is bound to its person and the deployment secret", async () => {
  const a = await unsubscribeToken(env, "user-a");
  assert.match(a, /^[0-9a-f]{64}$/u);
  assert.notEqual(a, await unsubscribeToken(env, "user-b"));
  assert.notEqual(a, await unsubscribeToken({ BETTER_AUTH_SECRET: "t".repeat(40) }, "user-a"));
  const url = await unsubscribeUrl(env, "https://hub.test", "user a");
  assert.equal(url, `https://hub.test/api/email/unsubscribe?u=user%20a&t=${await unsubscribeToken(env, "user a")}`);
});

test("the feedback email says it is free, how to reply, and carries the unsubscribe link in both parts", () => {
  const link = "https://hub.test/api/email/unsubscribe?u=x&t=y";
  const mail = feedbackProEmail(link);
  for (const part of [mail.text, mail.html]) {
    assert.ok(part.includes("不扣费") && part.includes("no charge"));
    assert.ok(part.includes("github.com/LambdaLabsHQ/xmatrix/issues"));
  }
  assert.ok(mail.text.includes(link));
  assert.ok(mail.html.includes(link.replaceAll("&", "&amp;")));
});

test("an Agent Run reaches campaign batches but no other campaign path", () => {
  assert.equal(allowed("POST", "/api/admin/email-campaigns/feedback-pro-2026-11/send"), true);
  assert.equal(allowed("GET", "/api/admin/email-campaigns/feedback-pro-2026-11/send"), false);
  assert.equal(allowed("POST", "/api/admin/email-campaigns/a/b/send"), false);
});
