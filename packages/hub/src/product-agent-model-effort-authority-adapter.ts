import { plainRecord as record } from "@xmatrix/protocol";
import type { ChannelSwitchContinuation } from "@xmatrix/protocol/connections/agent-instance";
import {
  orchestrateProductAgentControlCommands,
  parseProductAgentControlCommands,
  RELAY_RUNTIME_AGENT_CONTROL_SWITCH_PATH,
  RELAY_RUNTIME_AGENT_SWITCH_CONTINUATION_PATH,
  type ProductAgentControlOutcome,
  type ProductAgentControlPort,
  type ProductAgentControlResult,
} from "./product-agent-model-effort";
import { recordCommandResult } from "./command-result";
import { relayRuntimeCellsForOwners } from "./relay-authority-locator";
import { postgresMessageLiveAudience, withPostgresMessageRequestScope } from "./postgres-message-authority";
import { dispatchProductMessageAppend } from "./product-message-append";
import type { Env } from "./types";

/** The cells holding the Channel's Agent Instances: its active Runs' owners' own cells. */
async function channelInstanceCells(env: Env, channelId: string) {
  const { instanceOwnerUserIds } = await withPostgresMessageRequestScope(env,
    (scope) => postgresMessageLiveAudience(env, channelId, scope));
  return relayRuntimeCellsForOwners(env, instanceOwnerUserIds);
}



/**
 * A Runtime answer is only usable when it is one of the shapes the orchestrator
 * knows how to narrate; anything else is reported as a failure rather than
 * silently read as "switched".
 */
function outcomeFromRuntime(value: unknown): ProductAgentControlOutcome {
  const outcome = record(value);
  const owed = record(outcome?.continuation);
  const continuation = typeof owed?.instanceId === "string" && owed.instanceId &&
      typeof owed.requestId === "string" && owed.requestId
    ? { continuation: { instanceId: owed.instanceId, requestId: owed.requestId } } : {};
  switch (outcome?.status) {
    case "switched":
      return typeof outcome.selected === "string" && outcome.selected.trim()
        ? { status: "switched", selected: outcome.selected.trim(), ...continuation }
        : { status: "error", message: "the Runtime confirmed no selection.", ...continuation };
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
        ...continuation,
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
      const cells = await channelInstanceCells(input.env, channelId);
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

    async recordOutcomes(channelId, outcomes) {
      await recordCommandResult(input.env, { channelId, messageId: input.sourceMessageId,
        key: "controls", entry: { controls: outcomes } });
    },

    /* The continuation is an instruction to one Instance, not something
       anyone says in the Channel: its own socket carries it, and the Instance,
       still waiting on one of these switches, runs it unless newer input
       waits. A runtime that predates the frame reads it as a committed
       Channel instruction instead. */
    async continueTurn(channelId, { instanceId, requestIds, body }) {
      const cells = await channelInstanceCells(input.env, channelId);
      const delivered = await Promise.all(cells.map(async (runtime) => {
        const response = await runtime.fetch(
          new Request(`https://relay-runtime.internal${RELAY_RUNTIME_AGENT_SWITCH_CONTINUATION_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ channelId, instanceId, requestIds, prompt: body }),
          }),
        ).catch(() => undefined);
        return response?.ok === true && record(await response.json().catch(() => undefined))?.delivered === true;
      }));
      if (delivered.some(Boolean)) return;
      const messageId = `system:${input.sourceMessageId}:switch-continuation:${instanceId}`.slice(0, 200);
      const response = await dispatchProductMessageAppend(input.env, channelId, {
        commandId: `product:switch-continuation:${messageId}`.slice(0, 200),
        messageId,
        channelId,
        body,
        messageKind: "xmatrix.switch-continuation",
        principal,
        xmatrixAuthor: true,
        residual: {
          appMetadata: {
            xmatrixProvenance: "system_fact",
            xmatrixSystemNotice: true,
            sourceMessageId: input.sourceMessageId,
            xmatrixSwitchContinuation: { version: 1, instanceId, requestIds } satisfies ChannelSwitchContinuation,
          },
        },
      });
      if (!response.ok) throw new Error(`switch continuation failed (${response.status})`);
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
