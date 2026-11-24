import {
  PostgresSupportHandoffRepository, type SupportAccessNote, supportAccessNoteBody, type SupportReader,
} from "@xmatrix/db";
import {
  parseSupportHandoffRequest, SUPPORT_HANDOFF_PARTS, supportHandoffRequestProblem,
  type SupportHandoff, type SupportHandoffPart,
} from "@xmatrix/protocol";
import type { Context, Hono } from "hono";

import { platformAdminSpaceId } from "./admin-platform-access";
import type { AuthUser } from "./auth";
import { channelMessageCommand, channelMessageHistory } from "./channel-messages";
import { crossSpaceReadDatabase, runProof } from "./cross-space-read";
import { boundedDeploymentSpaceId } from "./deployment-space-access";
import { jsonErrors, requireAuth } from "./index-shared";
import { appendHubCard } from "./settings-card";
import { openConversation } from "./system-conversation";
import { XMATRIX_SYSTEM_AVATAR_URL } from "./xmatrix-system-identity";
import type { Env } from "./types";

/**
 * Hand to xMatrix support (docs/cross-space-read-grants.md#support-handoffs).
 * A person hands one of their conversations to the support Space: the Hub
 * records the grant, opens a support conversation there, and tells the
 * person's conversation. Support then reads only what the person ticked, as
 * them, while the grant is live; every read is shown in the person's
 * conversation, one note an hour, and support's replies land there as "xMatrix support".
 * The repository decides every authorization; these routes name principals
 * and post the messages.
 */

export const SUPPORT_LABEL = "xMatrix support";
export const SUPPORT_HANDOFF_MESSAGE_KIND = "xmatrix.system.support-handoff";
export const SUPPORT_ACCESS_MESSAGE_KIND = "xmatrix.system.support-access";
export const SUPPORT_REPLY_MESSAGE_KIND = "xmatrix.system.support-reply";
const REPLY_MAX = 4_000;
const HISTORY_LIMIT_MAX = 100;
const NO_STORE = { "cache-control": "private, no-store" };

/** The support Space: SUPPORT_SPACE_ID, else the deployment's platform admin Space; "" when neither is set. */
export function supportSpaceId(env: Pick<Env, "SUPPORT_SPACE_ID" | "PLATFORM_ADMIN_SPACE_ID">): string {
  return boundedDeploymentSpaceId(env.SUPPORT_SPACE_ID) || platformAdminSpaceId(env);
}

function repository(env: Env): PostgresSupportHandoffRepository {
  return new PostgresSupportHandoffRepository(crossSpaceReadDatabase(env));
}

function reader(user: AuthUser): SupportReader {
  return user.agentRun ? { kind: "run", proof: runProof(user.agentRun) } : { kind: "user", id: user.id };
}

const partLabel: Record<SupportHandoffPart, string> = {
  messages: "this conversation's messages", diagnostics: "diagnostics (execution states, failure codes)",
  logs: "recent daemon logs, redacted on their machine",
};

/** A system message the person's own conversation shows as from xMatrix support. */
function supportAuthor(ownerUserId: string, label = SUPPORT_LABEL) {
  return { principal: { kind: "user", id: ownerUserId },
    senderSnapshot: { identityId: `user:${ownerUserId}`, kind: "user", userId: ownerUserId, email: "",
      label, name: label, avatarUrl: XMATRIX_SYSTEM_AVATAR_URL } };
}

const quoted = (text: string) => text.split(/\r?\n/u).map((line) => `> ${line}`).join("\n");
const day = (iso: string) => iso.slice(0, 10);

/** The card that opens the support conversation, for support's eyes only. */
async function postSupportCard(env: Env, handoff: SupportHandoff, supportOwnerUserId: string,
  from: { name?: string; email: string }): Promise<void> {
  const included = handoff.parts.length ? handoff.parts.map((part) => `- ${partLabel[part]}`).join("\n")
    : "- nothing but this line";
  await appendHubCard(env, handoff.supportChannelId, {
    commandId: `support-handoff-open:${handoff.id}`, messageId: `support-handoff:${handoff.id}`,
    channelId: handoff.supportChannelId, messageKind: SUPPORT_HANDOFF_MESSAGE_KIND,
    ...supportAuthor(supportOwnerUserId, "Support handoff"),
    body: [`**${from.name || from.email}** (${from.email}) handed a conversation to xMatrix support:`, "",
      quoted(handoff.line), "", "They included:", included, "",
      `Readable until ${day(handoff.expiresAt)} unless they withdraw it. Each read is shown to them.`,
      ...(handoff.parts.includes("messages") ? ["",
        `Agents in this conversation read it with \`xmatrix channel history ${handoff.channelId}\`.`] : []),
      "Answer them on this card (it lands in their conversation as xMatrix support) or by email."].join("\n"),
    residual: { appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
      supportHandoff: { grantId: handoff.id, spaceId: handoff.spaceId, channelId: handoff.channelId,
        parts: handoff.parts, expiresAt: handoff.expiresAt, from: { email: from.email,
          ...(from.name ? { name: from.name } : {}) } } } },
  });
}

/** The person's own conversation records the handoff, with the way to withdraw it. */
async function postHandoffReceipt(env: Env, handoff: SupportHandoff): Promise<void> {
  const included = handoff.parts.length ? handoff.parts.map((part) => partLabel[part]).join(", ") : "only your note";
  await appendHubCard(env, handoff.channelId, {
    commandId: `support-handoff-receipt:${handoff.id}`, messageId: `support-handoff-receipt:${handoff.id}`,
    channelId: handoff.channelId, messageKind: SUPPORT_HANDOFF_MESSAGE_KIND, ...supportAuthor(handoff.ownerUserId),
    body: `You handed this conversation to xMatrix support: ${included}. Support can read it, read-only, ` +
      `until ${day(handoff.expiresAt)}; you can withdraw it any time.`,
    residual: { appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
      supportHandoff: { grantId: handoff.id, spaceId: handoff.spaceId, parts: handoff.parts,
        expiresAt: handoff.expiresAt } } },
  });
}

/**
 * "xMatrix support read this conversation (time)": the hour's first read posts
 * the note, and each later read in that hour edits the same note to say how
 * many reads there were and when the latest was. A note that fails to post
 * never fails the read it reports.
 */
export async function postSupportAccessNote(env: Env, note: SupportAccessNote | undefined,
  input: { grantId: string; spaceId: string; ownerUserId: string }): Promise<void> {
  if (!note) return;
  try {
    const messageId = `support-access:${input.grantId}:${note.notedAt}`.slice(0, 200);
    const body = supportAccessNoteBody(note);
    if (note.reads > 1) {
      await channelMessageCommand(env, note.channelId, "edit-message", {
        commandId: `support-access-edit:${input.grantId}:${note.latestAt}:${note.reads}`.slice(0, 200),
        messageId, channelId: note.channelId, body, principal: { kind: "user", id: input.ownerUserId },
      });
      return;
    }
    await appendHubCard(env, note.channelId, {
      commandId: messageId, messageId,
      channelId: note.channelId, messageKind: SUPPORT_ACCESS_MESSAGE_KIND, ...supportAuthor(input.ownerUserId),
      body,
      residual: { appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
        supportAccess: { grantId: input.grantId, spaceId: input.spaceId, readAt: note.notedAt } } },
    });
  } catch (error) {
    console.error("Support access note failed", { grantId: input.grantId,
      error: error instanceof Error ? error.message : String(error) });
  }
}

function humanOnly(c: Context<{ Bindings: Env }>, user: AuthUser): Response | undefined {
  return user.agentRun ? c.json({ error: "Only the person can do this, not an Agent", code: "human_required" }, 403)
    : undefined;
}

export function registerSupportHandoffRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/channels/:channelId/support-handoffs", (c) => jsonErrors(c, async () => {
    const user = await requireAuth(c.req.raw, c.env);
    const refused = humanOnly(c, user);
    if (refused) return refused;
    const body = await c.req.json<unknown>().catch(() => null);
    const problem = supportHandoffRequestProblem(body);
    const request = parseSupportHandoffRequest(body);
    if (problem || !request) {
      const consent = body && typeof body === "object" && (body as { consent?: unknown }).consent === true;
      return c.json({ error: problem, code: consent ? "invalid_request" : "consent_required" }, 400);
    }
    const supportSpace = supportSpaceId(c.env);
    if (!supportSpace) return c.json({ error: "xMatrix support is not set up on this deployment",
      code: "support_unavailable" }, 503);
    const handoffs = repository(c.env);
    const { handoff, supportOwnerUserId } = await handoffs.handOff({ requestId: crypto.randomUUID(),
      userId: user.id, channelId: c.req.param("channelId"), supportSpaceId: supportSpace,
      line: request.line, parts: request.parts,
      ...(request.logExcerpt !== undefined ? { logExcerpt: request.logExcerpt } : {}) });
    try {
      await openConversation(c.env, { spaceId: supportSpace, channelId: handoff.supportChannelId,
        name: `Support: ${handoff.line.replace(/\s+/gu, " ")}`, mode: "open", userId: supportOwnerUserId,
        metadata: { supportHandoff: { grantId: handoff.id, spaceId: handoff.spaceId } } });
      await postSupportCard(c.env, handoff, supportOwnerUserId, { email: user.email,
        ...(user.name ? { name: user.name } : {}) });
    } catch (error) {
      // Support never got it: nothing stays readable.
      await handoffs.revokeHandoff({ requestId: crypto.randomUUID(), spaceId: handoff.spaceId,
        grantId: handoff.id, userId: user.id });
      throw error;
    }
    await postHandoffReceipt(c.env, handoff).catch((error: unknown) => console.error("Support handoff receipt failed",
      { grantId: handoff.id, error: error instanceof Error ? error.message : String(error) }));
    return c.json({ handoff }, 201, NO_STORE);
  }));

  app.get("/api/spaces/:spaceId/support-handoffs/:grantId", (c) => jsonErrors(c, async () => {
    const user = await requireAuth(c.req.raw, c.env);
    const handoff = await repository(c.env).readHandoff({ requestId: crypto.randomUUID(),
      spaceId: c.req.param("spaceId"), grantId: c.req.param("grantId"), viewer: reader(user) });
    return c.json({ handoff }, 200, NO_STORE);
  }));

  app.get("/api/spaces/:spaceId/support-handoffs/:grantId/:part", (c) => jsonErrors(c, async () => {
    const part = c.req.param("part") as SupportHandoffPart;
    if (!(SUPPORT_HANDOFF_PARTS as readonly string[]).includes(part)) return c.json({ error: "Not found" }, 404);
    const user = await requireAuth(c.req.raw, c.env);
    const read = await repository(c.env).authorizeHandoffRead({ requestId: crypto.randomUUID(),
      spaceId: c.req.param("spaceId"), grantId: c.req.param("grantId"), reader: reader(user), part });
    const { handoff } = read;
    let answer: Record<string, unknown>;
    if (part === "messages") {
      const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), HISTORY_LIMIT_MAX);
      const beforeSequence = Number(c.req.query("beforeSequence"));
      // Read as the person, through the same authority their own reads use.
      answer = { history: await channelMessageHistory(c.env, { channelId: handoff.channelId, limit,
        ...(Number.isSafeInteger(beforeSequence) && beforeSequence > 0 ? { beforeSequence } : {}),
        principal: { kind: "user", id: handoff.ownerUserId } }) };
    } else {
      answer = part === "logs" ? { logExcerpt: read.logExcerpt ?? "" } : { diagnostics: read.diagnostics ?? [] };
    }
    await postSupportAccessNote(c.env, read.accessNote, { grantId: handoff.id, spaceId: handoff.spaceId,
      ownerUserId: handoff.ownerUserId });
    return c.json({ handoff, ...answer }, 200, NO_STORE);
  }));

  app.post("/api/spaces/:spaceId/support-handoffs/:grantId/revoke", (c) => jsonErrors(c, async () => {
    const user = await requireAuth(c.req.raw, c.env);
    const refused = humanOnly(c, user);
    if (refused) return refused;
    const handoff = await repository(c.env).revokeHandoff({ requestId: crypto.randomUUID(),
      spaceId: c.req.param("spaceId"), grantId: c.req.param("grantId"), userId: user.id });
    return c.json({ handoff }, 200, NO_STORE);
  }));

  app.post("/api/spaces/:spaceId/support-handoffs/:grantId/replies", (c) => jsonErrors(c, async () => {
    const user = await requireAuth(c.req.raw, c.env);
    const body = await c.req.json<{ body?: unknown }>().catch(() => null);
    const text = typeof body?.body === "string" ? body.body.trim() : "";
    if (!text || text.length > REPLY_MAX) return c.json({ error: `A reply is 1 to ${REPLY_MAX} characters`,
      code: "invalid_request" }, 400);
    const handoff = await repository(c.env).authorizeHandoffReply({ requestId: crypto.randomUUID(),
      spaceId: c.req.param("spaceId"), grantId: c.req.param("grantId"), reader: reader(user) });
    const replyId = crypto.randomUUID();
    await appendHubCard(c.env, handoff.channelId, {
      commandId: `support-reply:${replyId}`, messageId: `support-reply:${replyId}`, channelId: handoff.channelId,
      messageKind: SUPPORT_REPLY_MESSAGE_KIND, ...supportAuthor(handoff.ownerUserId), body: text,
      residual: { appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
        supportReply: { grantId: handoff.id, spaceId: handoff.spaceId } } },
    });
    return c.json({ messageId: `support-reply:${replyId}` }, 201, NO_STORE);
  }));
}
