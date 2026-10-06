import { plainRecord as record } from "@xmatrix/protocol";
import {
  orchestrateProductAgentControlCommands,
  parseProductAgentControlCommands,
  RELAY_RUNTIME_AGENT_CONTROL_SWITCH_PATH,
  type ProductAgentControlOutcome,
  type ProductAgentControlPort,
  type ProductAgentControlResult,
} from "./product-agent-model-effort";
import { productAgentSystemNoticeSenderSnapshot } from "./product-agent-mention-authority-adapter";
import { runtimeCellsForChannel } from "./runtime-transport/runtime-route-directory-delivery";
import { dispatchProductMessageAppend } from "./product-message-append";
import type { Env } from "./types";



/**
 * A Runtime answer is only usable when it is one of the shapes the orchestrator
 * knows how to narrate; anything else is reported as a failure rather than
 * silently read as "switched".
 */
function outcomeFromRuntime(value: unknown): ProductAgentControlOutcome {
  const outcome = record(value);
  switch (outcome?.status) {
    case "switched":
      return typeof outcome.selected === "string" && outcome.selected.trim()
        ? { status: "switched", selected: outcome.selected.trim() }
        : { status: "error", message: "the Runtime confirmed no selection." };
    case "catalog": {
      const options = Array.isArray(outcome.options)
        ? outcome.options.filter((option): option is string => typeof option === "string")
        : [];
      return {
        status: "catalog",
        options,
        ...(typeof outcome.current === "string" && outcome.current.trim()
          ? { current: outcome.current.trim() }
          : {}),
      };
    }
    case "no_instance":
      return { status: "no_instance" };
    case "error":
      return {
        status: "error",
        message: typeof outcome.message === "string" && outcome.message.trim()
          ? outcome.message.trim()
          : "the Runtime reported an unspecified failure.",
      };
    default:
      return { status: "error", message: "the Runtime returned an unreadable result." };
  }
}

export function createProductAgentControlAuthorityPort(input: {
  env: Env;
  actorUserId: string;
  sourceMessageId: string;
}): ProductAgentControlPort {
  const principal = { kind: "user" as const, id: input.actorUserId };

  return {
    async switchControl({ channelId, target, kind, value }) {
      // The waiter registry is Runtime process memory, so the whole
      // request/confirm exchange has to happen inside the Durable Object
      // holding the Instance's socket; ask every cell that may hold it.
      const cells = await runtimeCellsForChannel(input.env, channelId);
      const outcomes = await Promise.all(cells.map(async (runtime): Promise<ProductAgentControlOutcome> => {
        const response = await runtime.fetch(
          new Request(`https://relay-runtime.internal${RELAY_RUNTIME_AGENT_CONTROL_SWITCH_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ channelId, target, kind, ...(value ? { value } : {}) }),
          }),
        ).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
        if (response instanceof Error) return { status: "error", message: response.message };
        const body = record(await response.json().catch(() => undefined));
        if (!response.ok) {
          const detail = typeof body?.error === "string" && body.error.trim()
            ? body.error.trim()
            : `Runtime responded ${response.status}`;
          return { status: "error", message: detail };
        }
        return outcomeFromRuntime(body?.outcome);
      }));
      // The Instance lives in one cell; the others answer that they have none.
      return outcomes.find((outcome) => outcome.status !== "no_instance" && outcome.status !== "error") ??
        outcomes.find((outcome) => outcome.status === "error") ??
        outcomes[0] ?? { status: "no_instance" };
    },

    async publishSystemNotice(channelId, body) {
      const messageId = `system:${input.sourceMessageId}:control-switch`.slice(0, 200);
      const response = await dispatchProductMessageAppend(input.env, channelId, {
        commandId: `product:control-switch-notice:${messageId}`.slice(0, 200),
        messageId,
        channelId,
        body,
        principal,
        senderSnapshot: productAgentSystemNoticeSenderSnapshot(input.actorUserId),
        residual: {
          appMetadata: {
            // The receipt is a control-plane fact. Committing it without this
            // provenance would hand the switch confirmation back to the very
            // Instance that was switched, as fresh work.
            xmatrixProvenance: "system_fact",
            xmatrixSystemNotice: true,
            sourceMessageId: input.sourceMessageId,
          },
        },
      });
      if (!response.ok) {
        const result = record(await response.json().catch(() => undefined));
        const detail = typeof result?.error === "string" && result.error.trim()
          ? `: ${result.error.trim()}`
          : "";
        throw new Error(`control switch notice failed (${response.status})${detail}`);
      }
    },
  };
}

export async function dispatchProductAgentControlAfterAuthorityMessage(input: {
  env: Env;
  channelId: string;
  messageId: string;
  body: string;
  actorUserId: string;
}): Promise<ProductAgentControlResult[]> {
  if (parseProductAgentControlCommands(input.body).length === 0) return [];
  return orchestrateProductAgentControlCommands({
    channelId: input.channelId,
    body: input.body,
    port: createProductAgentControlAuthorityPort({
      env: input.env,
      actorUserId: input.actorUserId,
      sourceMessageId: input.messageId,
    }),
  });
}
