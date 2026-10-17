import type { Hono } from "hono";
import { ControlError } from "@xmatrix/db";
import {
  ONBOARDING_MESSAGE_KIND, onboardingLocale, type AgentRegistrationSummary, type OnboardingLocale, type OnboardingStage,
} from "@xmatrix/protocol";
import type { Env } from "./types";
import { listAgentRegistrations } from "./agent-registrations";
import { deterministicConversationId } from "./deterministic-id";
import { jsonErrors, requireAuth, requireHumanAuth } from "./index-shared";
import { postgresMessageExists, withPostgresMessageRequestScope } from "./postgres-message-authority";
import { dispatchProductMessageAppend } from "./product-message-append";
import { createChannel, getSpace, personalSpaceId } from "./spaces";
import { XMATRIX_SYSTEM_AVATAR_URL, XMATRIX_SYSTEM_LABEL } from "./xmatrix-system-identity";

const NO_STORE = { "cache-control": "private, no-store" };

/* What a client that cannot draw the step reads, and what an Agent in the
   conversation sees. The Web draws each step from the facts instead. Written
   in the language the person's browser asked for (onboardingLocale). */
const WELCOME = {
  en: {
    name: "Welcome to xMatrix",
    bringAgents: "Bring your agents into xMatrix. They keep running on your own computer: open xmatrix.sh there, " +
      "sign in and run the one command it shows, or download the desktop app.",
    agentsIn: (handles: string[]) => `${handles.join(", ")} ${handles.length === 1 ? "is" : "are"} in. ` +
      `Mention ${handles.length === 1 ? "it" : "one"} here to give ${handles.length === 1 ? "it" : "them"} work.`,
  },
  zh: {
    name: "欢迎来到 xMatrix",
    bringAgents: "把你的 Agent 带进 xMatrix。它们照常在你自己的电脑上运行：在那台电脑上打开 xmatrix.sh，" +
      "登录后运行页面上的那条命令，或者下载桌面 App。",
    agentsIn: (handles: string[]) => `${handles.join("、")} 已接入。在这里 @ ${handles.length === 1 ? "它" : "其中一个"}就能派活。`,
  },
} satisfies Record<OnboardingLocale, { name: string; bringAgents: string; agentsIn: (handles: string[]) => string }>;

/**
 * A new person's personal Space opens with a conversation in which xMatrix
 * tells them how to bring their agents in, then, once one is in, that it is
 * (docs/architecture/first-space.md). Each message is written once under a
 * fixed id, so a reload, a second tab or a retry replays it rather than
 * repeating it. Only the person's own personal Space gets one.
 */
export function registerWelcomeRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/spaces/:spaceId/welcome", (c) => jsonErrors(c, async () => {
    const owner = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    const spaceId = c.req.param("spaceId");
    // Older clients post no body: English.
    const request = await c.req.json().catch(() => null) as { locale?: unknown } | null;
    const words = WELCOME[onboardingLocale(typeof request?.locale === "string" ? request.locale : null)];
    if (spaceId !== await personalSpaceId(owner.id)) return c.json({ channelId: null }, 200, NO_STORE);
    const principal = { kind: "user" as const, id: owner.id };
    // Membership, read as the caller: a deleted personal Space is not reopened.
    await getSpace(c.env, { spaceId, principal });
    const channelId = await deterministicConversationId("welcome-conversation", spaceId);
    try {
      await createChannel(c.env, {
        commandId: `welcome-conversation:${spaceId}`, channelId, spaceId,
        name: words.name, mode: "closed", principal, metadata: { welcome: true },
      });
    } catch (error) {
      // Made by an earlier call: the conversation is the person's now.
      if (!(error instanceof ControlError && error.status === 409)) throw error;
    }
    await appendWelcomeStep(c.env, owner, channelId, "bring-agents", words.bringAgents);
    const handles = await enabledAgentHandles(c.env, owner.id, spaceId);
    if (handles.length > 0) await appendWelcomeStep(c.env, owner, channelId, "agents-in", words.agentsIn(handles));
    return c.json({ channelId }, 200, NO_STORE);
  }));
}

async function appendWelcomeStep(env: Env, owner: { id: string; email: string }, channelId: string,
  stage: OnboardingStage, body: string): Promise<void> {
  const messageId = `system:welcome:${channelId}:${stage}`;
  const written = () => withPostgresMessageRequestScope(env, (scope) => postgresMessageExists(env, {
    channelId, messageId, principal: { kind: "user", id: owner.id },
  }, scope));
  // The first published step is a historical fact. Handles and account details
  // may change; rebuilding that command would conflict with its original digest.
  // Read the durable message, whose identity outlives the idempotency record.
  if (await written()) return;
  const response = await dispatchProductMessageAppend(env, channelId, {
    commandId: `product:welcome:${channelId}:${stage}`, messageId, channelId, body,
    messageKind: ONBOARDING_MESSAGE_KIND,
    principal: { kind: "user", id: owner.id },
    senderSnapshot: { identityId: `user:${owner.id}`, kind: "user", userId: owner.id, email: owner.email,
      label: XMATRIX_SYSTEM_LABEL, name: XMATRIX_SYSTEM_LABEL, avatarUrl: XMATRIX_SYSTEM_AVATAR_URL },
    // xMatrix's words, not the owner's: no Agent takes them as work.
    residual: { appMetadata: { kind: ONBOARDING_MESSAGE_KIND, stage, xmatrixProvenance: "system_fact", xmatrixSystemNotice: true } },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 409) {
      const failure = JSON.parse(detail);
      // Another tab can commit after append's preflight: its different prepared
      // timestamp also makes our sequence reservation stale. In every case,
      // confirm the exact step committed before acknowledging that conflict.
      if (["idempotency_conflict", "message_exists", "message_sequence_reservation_invalid"].includes(failure.code) &&
          await written()) return;
    }
    throw new Error(`welcome ${stage} message failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
}

async function enabledAgentHandles(env: Env, ownerUserId: string, spaceId: string): Promise<string[]> {
  const { registrations } = await listAgentRegistrations(env, { actorUserId: ownerUserId, spaceId, limit: 50 });
  return [...new Set((registrations as AgentRegistrationSummary[])
    .filter((registration) => registration.state === "enabled")
    .map((registration) => `@${registration.displayName}`))];
}
