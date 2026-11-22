/**
 * Operator email campaigns and the one-click unsubscribe every one carries.
 *
 * The caller names people by user id, never by address, so a batch request
 * (and its record in a Channel) exposes no email. The Hub skips anyone who
 * unsubscribed or deleted their account, mails each person at most once per
 * campaign, and sends only wording fixed in code.
 */

import type { Hono } from "hono";
import { PostgresEmailCampaignRepository } from "@xmatrix/db";
import { timingSafeEqual } from "@xmatrix/protocol";

import { authDirectoryEmails } from "./auth-authority";
import { EMAIL_UNSUBSCRIBE_ROUTE, unsubscribeToken, unsubscribeUrl } from "./email-unsubscribe-token";
import { sendEmail } from "./email-delivery";
import { FEEDBACK_PRO_CAMPAIGN, FEEDBACK_REPLY_TO, feedbackProEmail } from "./email-campaign-feedback-pro";
import { grantOperator } from "./index-routes-billing-grants";
import { internalAddress } from "./internal-accounts";
import { jsonErrors, readBoundedRequestBody } from "./index-shared";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS } from "./postgres-authority-http";
import type { Env } from "./types";

const MAX_BATCH = 50;
export const INTERNAL_EMAILS_ROUTE = "/api/admin/internal-email-addresses";
const PRIVATE = { "cache-control": "private, no-store" };
const CAMPAIGNS: Record<string, (unsubscribeUrl: string) => { subject: string; text: string; html: string }> = {
  [FEEDBACK_PRO_CAMPAIGN]: feedbackProEmail,
};

function repository(env: Env) {
  return new PostgresEmailCampaignRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-hub-email-campaigns", ...POSTGRES_AUTHORITY_TIMEOUTS,
  }));
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:64px auto;padding:0 16px;line-height:1.6"><h1 style="font-size:20px">${title}</h1><p>${body}</p></body></html>`;
}

export function registerIndexRoutesEmailCampaigns(app: Hono<{ Bindings: Env }>): void {
  // GET is the link in the email; POST is RFC 8058 one-click from the mail client.
  const unsubscribe = async (env: Env, userId: string, token: string): Promise<boolean> => {
    if (!userId || userId.length > 300 || !/^[0-9a-f]{64}$/u.test(token)) return false;
    if (!timingSafeEqual(await unsubscribeToken(env, userId), token)) return false;
    await repository(env).unsubscribe(crypto.randomUUID(), userId);
    return true;
  };
  app.get(EMAIL_UNSUBSCRIBE_ROUTE, async (c) => {
    const ok = await unsubscribe(c.env, c.req.query("u") ?? "", c.req.query("t") ?? "");
    return c.html(ok
      ? page("已退订 / Unsubscribed", "你不会再收到 xMatrix 的活动邮件；登录、账单和安全邮件不受影响。<br>You won't get xMatrix campaign emails again. Sign-in, billing and security emails are unaffected.")
      : page("链接无效 / Invalid link", "这个退订链接无效。请回复任意一封邮件告诉我们。<br>This unsubscribe link is not valid. Reply to any of our emails and we will remove you."),
    ok ? 200 : 400, PRIVATE);
  });
  app.post(EMAIL_UNSUBSCRIBE_ROUTE, async (c) => {
    const ok = await unsubscribe(c.env, c.req.query("u") ?? "", c.req.query("t") ?? "");
    return c.json({ unsubscribed: ok }, ok ? 200 : 400, PRIVATE);
  });

  /* The operator's own addresses that no domain rule catches. */
  app.get(INTERNAL_EMAILS_ROUTE, (c) => jsonErrors(c, async () => {
    await grantOperator(c.req.raw, c.env, "internal-email.manage", { kind: "internal-emails", id: "list" });
    return c.json({ emails: await repository(c.env).internalAddresses(crypto.randomUUID()) }, 200, PRIVATE);
  }));
  for (const method of ["post", "delete"] as const) {
    app[method](INTERNAL_EMAILS_ROUTE, (c) => jsonErrors(c, async () => {
      const buffer = await readBoundedRequestBody(c.req.raw, 1_024);
      let email = "";
      try { email = String((JSON.parse(new TextDecoder().decode(buffer ?? new Uint8Array())) as { email?: unknown }).email ?? "").trim(); } catch { /* invalid below */ }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email) || email.length > 320) {
        return c.json({ error: "Pass one email address", code: "invalid_internal_email" }, 400, PRIVATE);
      }
      const actor = await grantOperator(c.req.raw, c.env, "internal-email.manage", { kind: "internal-emails", id: method });
      const repo = repository(c.env);
      if (method === "post") await repo.addInternalAddress(crypto.randomUUID(), email, actor);
      else await repo.removeInternalAddress(crypto.randomUUID(), email);
      return c.json({ emails: await repo.internalAddresses(crypto.randomUUID()) }, 200, PRIVATE);
    }));
  }

  /* Send one batch of a campaign to people named by user id. `dryRun` reports
     who would be mailed without claiming or sending anything. */
  app.post("/api/admin/email-campaigns/:campaign/send", (c) => jsonErrors(c, async () => {
    const campaign = c.req.param("campaign");
    const build = CAMPAIGNS[campaign];
    if (!build) return c.json({ error: "Unknown campaign", code: "unknown_campaign" }, 404, PRIVATE);
    const buffer = await readBoundedRequestBody(c.req.raw, 32_768);
    if (buffer === null) return c.json({ error: "Request body is too large", code: "invalid_campaign_batch" }, 413, PRIVATE);
    let body: { userIds?: unknown; dryRun?: unknown } = {};
    try { body = JSON.parse(new TextDecoder().decode(buffer)) ?? {}; } catch { /* invalid below */ }
    const userIds = Array.isArray(body.userIds) ? body.userIds.filter((id): id is string =>
      typeof id === "string" && id.length > 0 && id.length <= 300) : [];
    if (!userIds.length || userIds.length !== (body.userIds as unknown[]).length || userIds.length > MAX_BATCH) {
      return c.json({ error: `Pass 1–${MAX_BATCH} user ids`, code: "invalid_campaign_batch" }, 400, PRIVATE);
    }
    const dryRun = body.dryRun === true;
    await grantOperator(c.req.raw, c.env, "email-campaign.send", { kind: "campaign", id: campaign });
    const repo = repository(c.env);
    const { eligible, skipped } = await repo.eligible(crypto.randomUUID(), campaign, userIds, !dryRun);
    const emails = await authDirectoryEmails(c.env, eligible);
    const noEmail = eligible.filter((id) => !emails.get(id));
    // Operator and QA addresses are never campaign recipients.
    const listed = new Set(await repo.internalAddresses(crypto.randomUUID()));
    const internal = eligible.filter((id) => internalAddress(c.env, emails.get(id), listed));
    if (dryRun) {
      return c.json({ dryRun: true, wouldSend: eligible.length - noEmail.length - internal.length,
        skipped: { ...skipped, noEmail: noEmail.length, internal: internal.length } }, 200, PRIVATE);
    }
    const origin = new URL(c.req.url).origin;
    let sent = 0;
    const failed: string[] = [];
    for (const userId of eligible) {
      const address = emails.get(userId);
      if (internal.includes(userId)) { await repo.record(crypto.randomUUID(), campaign, userId, "failed"); continue; }
      if (!address) { await repo.record(crypto.randomUUID(), campaign, userId, "failed"); failed.push(userId); continue; }
      const link = await unsubscribeUrl(c.env, origin, userId);
      try {
        await sendEmail(c.env, address, { ...build(link), headers: { replyTo: FEEDBACK_REPLY_TO, unsubscribeUrl: link } });
        await repo.record(crypto.randomUUID(), campaign, userId, "sent");
        sent++;
      } catch {
        await repo.record(crypto.randomUUID(), campaign, userId, "failed");
        failed.push(userId);
      }
    }
    // Failed sends stay claimed: an operator looks at them rather than mailing twice.
    return c.json({ sent, failed, skipped: { ...skipped, internal: internal.length } }, 200, PRIVATE);
  }));
}
