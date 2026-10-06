import type { Env } from "./types";
import { dispatchProductMessageAppend } from "./product-message-append";
import { sha256Hex } from "@xmatrix/protocol";

/** Publish the immutable Channel-side fact paired with a management Automation action. */
export async function publishAutomationSystemFact(input: {
  env: Env;
  ownerUserId: string;
  channelId: string;
  actionId: string;
  phase: "pending" | "result";
  body: string;
  metadata: Record<string, unknown>;
}): Promise<Response | undefined> {
  const digest = await sha256Hex(`automation:${input.actionId}:${input.phase}`);
  const response = await dispatchProductMessageAppend(input.env, input.channelId, {
    commandId: `automation-system-fact:${digest}`.slice(0, 200),
    messageId: `automation-system-fact:${digest}`.slice(0, 200),
    channelId: input.channelId,
    body: input.body,
    principal: { kind: "user", id: input.ownerUserId },
    senderSnapshot: {
      identityId: `user:${input.ownerUserId}`,
      kind: "user",
      userId: input.ownerUserId,
      label: "xMatrix",
      name: "xMatrix",
      avatarUrl: "/brand/xmatrix-management-icon.png",
    },
    residual: {
      appMetadata: {
        // Audit facts are evaluator context, never fresh Agent work.
        xmatrixProvenance: "system_fact",
        xmatrixSystemNotice: true,
        automationFactKind: input.phase === "pending" ? "management_judgment" : "approved_action_result",
        automationActionId: input.actionId,
        automationPhase: input.phase,
        ...input.metadata,
      },
    },
  });
  if (response.ok) return undefined;
  return Response.json({
    error: "Automation action committed, but its required Channel audit message is pending retry",
    code: "automation_audit_message_pending",
    actionId: input.actionId,
  }, { status: 503 });
}
