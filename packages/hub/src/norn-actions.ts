import { AppControlError } from "@xmatrix/db";
import { getAppConnectorProvider } from "./app-connectors";
import { connectorActionCatalog } from "./connectors/action-catalog";
import { announceActionRequests, heldAuthorityFailure, stageHeldAction } from "./connectors/connector-commands";
import { connectorActionRequestRepository } from "./connectors/credentials";
import type { ConnectorAction } from "./connectors/provider";
import { connectorProvider } from "./connectors/registry";
import { enqueueXUpload } from "./connectors/x-upload-executor-do";
import { nornPreparedReply, type NornAppRequest } from "./norn-host";
import { nornActionStatement } from "./norn-libraries";
import type { Env } from "./types";
import type { Reply } from "./vendor/norn/runtime/ledger";

/**
 * What the host does for a Norn program's request of a connected app
 * (docs/architecture/norn-host.md "Asking a connected app"). `prepare` stages
 * the action as a Channel command would, frozen and held; `perform` runs what
 * was admitted, once, through the durable executor. No Agent takes part.
 */

/** How long an approval can wait for an answer, and an approved action for its `perform`. */
const APPROVAL_MS = 30 * 24 * 60 * 60_000;
/** How long the host waits to hear how a performed action ended before it reads it as lost. */
const PERFORM_REPORT_MS = 30 * 60_000;

/** The executor of one action of a connected app, as the provider installs it. */
export function nornActionExecutor(providerId: string, actionId: string): ConnectorAction | undefined {
  const provider = connectorProvider(providerId);
  return provider ? connectorActionCatalog(provider.id, provider.actions).get(actionId)?.executor : undefined;
}

/**
 * How a delivery to a connected app went: the request is the host's to hear
 * about (`held`), with what to say in the conversation, or it ended at once
 * with `reply`.
 */
export type NornAppDelivery = { held: { dueInMs: number }; say?: string } | { reply: Reply; say?: string };

export async function deliverNornAppRequest(env: Env, input: { spaceId: string; channelId: string; authorityUserId: string;
  request: NornAppRequest; requestRef: string; deliveryMessageId: string;
  /** The reference of the `prepare` a `perform` does, when the program's index knows it. */
  preparedRef?: string }): Promise<NornAppDelivery> {
  const { app, name } = input.request.action;
  const label = `${getAppConnectorProvider(app)?.name ?? app} ${name}`;
  if (input.request.verb === "prepare") {
    const statement = nornActionStatement(app, name, input.request.action.input);
    if ("refusal" in statement) return { reply: { tag: "Broke", reason: statement.refusal } };
    const action = nornActionExecutor(app, name);
    if (!action) return { reply: { tag: "Broke", reason: `${label} is not an action this host runs` } };
    const staged = await stageHeldAction(env, { channelId: input.channelId, actorUserId: input.authorityUserId,
      messageId: input.deliveryMessageId, providerId: app, actionId: name, action, statement, heldFor: input.requestRef });
    if ("reason" in staged) {
      return { reply: staged.status === "blocked" ? { tag: "Refused", reason: staged.reason } : { tag: "Broke", reason: staged.reason },
        say: `${label}: ${staged.status}; ${staged.reason}` };
    }
    if (staged.status === "pending") {
      return { held: { dueInMs: APPROVAL_MS }, say: `${label}: awaiting approval. A Space admin answers it in this conversation's Pending approvals; it runs when the program performs it, not when it is approved.` };
    }
    return { reply: nornPreparedReply(input.request), say: `${label}: admitted by the app's Read and write permission. It runs when the program performs it.` };
  }
  if (!input.preparedRef) return { reply: { tag: "Broke", reason: "What was prepared is not known to this host" } };
  const repository = connectorActionRequestRepository(env);
  let claimed: Awaited<ReturnType<typeof repository.claimHeld>>;
  try {
    claimed = await repository.claimHeld({ spaceId: input.spaceId, channelId: input.channelId, prepareRef: input.preparedRef,
      performRef: input.requestRef });
  } catch (error) {
    // What was approved no longer holds: the approver, the connection or its account changed. Anything else is tried again.
    if (!(error instanceof AppControlError)) throw error;
    return { reply: { tag: "Refused", reason: heldAuthorityFailure(error) ?? error.message } };
  }
  if (!claimed.request) return { reply: { tag: "Refused", reason: claimed.refusal } };
  // Durable before it is acknowledged: the executor runs it once and keeps its outcome until the program has it.
  await enqueueXUpload(env, { requestId: claimed.request.requestId, spaceId: input.spaceId, channelId: input.channelId });
  return { held: { dueInMs: PERFORM_REPORT_MS } };
}

/**
 * Programs no longer ask for these: an approval nobody answered leaves
 * Pending approvals, and with `ended` one that was given and never used is
 * void too.
 */
export async function withdrawNornAppRequests(env: Env, input: { spaceId: string; prepareRefs: string[]; ended?: boolean }): Promise<void> {
  const channels = await connectorActionRequestRepository(env).withdrawHeld({ spaceId: input.spaceId, prepareRefs: input.prepareRefs,
    ...(input.ended ? { approved: true } : {}) });
  for (const channelId of new Set(channels)) await announceActionRequests(env, input.spaceId, channelId);
}
