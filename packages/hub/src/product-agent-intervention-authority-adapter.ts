import { plainRecord as record } from "@xmatrix/protocol";
import {
  orchestrateProductAgentIntervention,
  parseProductAgentStopCommand,
  AgentStopPendingError,
  type ProductAgentInterventionPort,
  type ProductAgentInterventionResult,
  type ProductAgentHandoffExport,
  type ProductAgentKillTarget,
} from "./product-agent-intervention";
import { productAgentSystemNoticeSenderSnapshot } from "./product-agent-mention-authority-adapter";
import { probeAuthorityUntilTerminal } from "./authority-probe-backoff";
import { dispatchProductMessageAppend } from "./product-message-append";
import type { AgentRunPrincipal } from "./auth";
import type { Env } from "./types";
import { finalizeConfirmedAgentStop } from "./product-agent-stop-finalization";
import { ControlError } from "@xmatrix/db";
import { machineCommandStatus, machineDaemonCommand, machineRepository } from "./machines";
import { runtimeRepository } from "./runtime";

const CHANNEL_AGENT_STOP_RESULT_TIMEOUT_MS = 20_000;
const AGENT_INTERVENTION_AUTHORITY_RETRY_TIMEOUT_MS = 3_000;



async function payload(response: Response): Promise<Record<string, unknown>> {
  return record(await response.json().catch(() => ({}))) || {};
}

function responseError(operation: string, response: Response, value: Record<string, unknown>): Error {
  const detail = typeof value.error === "string" && value.error.trim()
    ? `: ${value.error.trim()}`
    : "";
  return new Error(`${operation} failed (${response.status})${detail}`);
}

function stableCommandId(family: string, value: string): string {
  return `product:${family}:${value}`.slice(0, 200);
}

/** Retries a direct authority call through a short outage; a definite rejection ends it at once. */
async function retryTransient<T>(request: () => Promise<T>): Promise<T> {
  let latestError: unknown;
  const done = await probeAuthorityUntilTerminal<{ value: T }>({
    deadlineAtMs: Date.now() + AGENT_INTERVENTION_AUTHORITY_RETRY_TIMEOUT_MS,
    probe: async () => {
      try {
        return { value: await request() };
      } catch (error) {
        if (error instanceof ControlError && error.status !== 503 && !error.retryable) throw error;
        latestError = error;
        return undefined;
      }
    },
  });
  if (done) return done.value;
  throw latestError instanceof Error ? latestError : new Error("Authority request failed");
}

async function retryTransientAuthorityResponse(
  request: () => Promise<Response>,
): Promise<Response> {
  let latest: Response | undefined;
  let latestError: unknown;
  const terminal = await probeAuthorityUntilTerminal<Response>({
    deadlineAtMs: Date.now() + AGENT_INTERVENTION_AUTHORITY_RETRY_TIMEOUT_MS,
    probe: async () => {
      try {
        latest = await request();
        return latest.status === 503 ? undefined : latest;
      } catch (error) {
        latestError = error;
        return undefined;
      }
    },
  });
  if (terminal) return terminal;
  if (latest) return latest;
  throw latestError instanceof Error ? latestError : new Error("Authority request failed");
}

export function createProductAgentInterventionAuthorityPort(input: {
  env: Env;
  actorUserId: string;
  sourceMessageId: string;
}): ProductAgentInterventionPort {
  const principal = { kind: "user" as const, id: input.actorUserId };
  const runtime = () => runtimeRepository(input.env);

  // listKillTargets already authorized the Human against the Channel's Space
  // and returned this exact live target. The command is queued for the
  // Machine owner's daemon, which is where it claims commands.
  async function issueDaemonStop(target: ProductAgentKillTarget, controlId: string, reason: string,
    channelId: string | undefined, handoffExport?: ProductAgentHandoffExport): Promise<void> {
    await retryTransient(() =>
      machineDaemonCommand(input.env, {
        commandId: stableCommandId("machine-stop", controlId),
        action: "issue",
        controlId,
        commandType: "stop",
        ownerUserId: target.machineOwnerUserId,
        ownerEmail: `${target.machineOwnerUserId.replace(/[^a-zA-Z0-9._-]/gu, "_")}@unknown.invalid`,
        machineId: target.machineId,
        hostId: target.hostId,
        payload: {
          type: "machine_stop_agent",
          requestId: controlId,
          runId: target.runId,
          channelId,
          executionKey: target.executionKey,
          agentId: target.agentId,
          instanceId: target.instanceId,
          reason,
          worktreeDisposition: "retain",
          ...(handoffExport ? { handoffExport } : {}),
        },
        metadata: {},
        capabilities: [],
        principal: { kind: "user", id: target.machineOwnerUserId },
      }));
  }

  /** The daemon's terminal stop report, or none before the deadline. */
  async function awaitDaemonStopResult(target: ProductAgentKillTarget, controlId: string,
    timeoutMs: number): Promise<Record<string, unknown> | undefined> {
    return probeAuthorityUntilTerminal<Record<string, unknown>>({
      deadlineAtMs: Date.now() + timeoutMs,
      probe: async () => {
        const statusPayload = await machineCommandStatus(machineRepository(input.env), "stop", {
          controlId,
          runId: target.runId,
          executionKey: target.executionKey,
          agentId: target.agentId,
          instanceId: target.instanceId,
          ownerUserId: target.machineOwnerUserId,
          machineId: target.machineId,
          hostId: target.hostId,
          worktreeDisposition: "retain",
        });
        if (statusPayload.status === "completed") return record(statusPayload.result) ?? {};
        if (statusPayload.status === "failed") {
          throw new Error("Machine Daemon could not stop the Agent process tree");
        }
        return undefined;
      },
    });
  }

  return {
    async listKillTargets(channelId) {
      // Stopping every Agent in a busy Channel must see every Agent in it.
      const listed: unknown[] = [];
      let cursor: string | null = null;
      do {
        const page = await runtime().listChannelAgentKillTargets({ requestId: crypto.randomUUID(),
          channelId, actorUserId: input.actorUserId, cursor, limit: 200 });
        listed.push(...page.targets);
        cursor = typeof page.cursor === "string" ? page.cursor : null;
      } while (cursor);
      const targetPayload = { targets: listed };
      const targets = Array.isArray(targetPayload.targets) ? targetPayload.targets : [];
      return targets.flatMap((rawTarget): ProductAgentKillTarget[] => {
        const target = record(rawTarget);
        const instanceId = typeof target?.instanceId === "string" ? target.instanceId : "";
        const runId = typeof target?.runId === "string" ? target.runId : "";
        const agentId = typeof target?.agentId === "string" ? target.agentId : "";
        const mentionTarget = typeof target?.mentionTarget === "string" ? target.mentionTarget : "";
        const ownerUserId = typeof target?.ownerUserId === "string" ? target.ownerUserId : "";
        const machineOwnerUserId = typeof target?.machineOwnerUserId === "string"
          ? target.machineOwnerUserId
          : "";
        const machineId = typeof target?.machineId === "string" ? target.machineId : "";
        const hostId = typeof target?.hostId === "string" ? target.hostId : "";
        if (!instanceId || !runId || !agentId || !mentionTarget || !ownerUserId ||
            !machineOwnerUserId || !machineId) return [];
        return [{
          instanceId,
          runId,
          agentId,
          mentionTarget,
          ownerUserId,
          machineOwnerUserId,
          machineId,
          hostId,
          ...(typeof target?.executionKey === "string"
            ? { executionKey: target.executionKey }
            : {}),
          ...(typeof target?.stopRequestSourceMessageId === "string"
            ? { stopRequestSourceMessageId: target.stopRequestSourceMessageId }
            : {}),
        }];
      });
    },

    async daemonOnline(target) {
      // listKillTargets authorized this exact target; its daemon row belongs to
      // the machine owner, like the stop command itself.
      const route = await machineRepository(input.env).getDaemon({ requestId: crypto.randomUUID(),
        ownerUserId: target.machineOwnerUserId, machineId: target.machineId, hostId: target.hostId })
        .catch(() => undefined);
      const status = record(route?.daemon)?.status;
      return typeof status === "string" ? status === "online" : undefined;
    },

    async issueStop(target, controlId, reason, channelId, waitForTermination = false) {
      await issueDaemonStop(target, controlId, reason, channelId);
      // Exact-address stops retain their asynchronous contract: the command
      // receipt reports queueing, then the daemon reports terminal execution.
      // /kill all waits so its aggregate result counts only confirmed stops.
      if (!channelId || !waitForTermination) return;
      if (!target.executionKey) {
        throw new Error("daemon stop target is missing its exact execution key");
      }
      const stopped = await awaitDaemonStopResult(target, controlId, CHANNEL_AGENT_STOP_RESULT_TIMEOUT_MS);
      if (!stopped) throw new AgentStopPendingError("Machine Daemon stop is awaiting host confirmation");

      // Machine command/result authority is User-scoped, while Run/Instance
      // lifecycle is Space-scoped. Commit the terminal lifecycle only after
      // the exact daemon result proves the host process tree is gone.
      const lifecycle = runtime();
      /** Another writer moved the entity on first: the finalizer re-reads and decides again. */
      const transition = async (command: Record<string, unknown>) => {
        try {
          await lifecycle.mutate({ ...command, actorUserId: target.ownerUserId, at: new Date().toISOString() });
          return "applied" as const;
        } catch (error) {
          if (error instanceof ControlError && error.status === 409) return "conflict" as const;
          throw error;
        }
      };
      await finalizeConfirmedAgentStop({ runId: target.runId, instanceId: target.instanceId,
        versionedAuthority: true, port: {
          async readRun() {
            return record((await lifecycle.getRun({ requestId: crypto.randomUUID(), runId: target.runId,
              actorUserId: target.ownerUserId })).run) ?? {};
          },
          async readInstance() {
            return record((await lifecycle.getInstance({ requestId: crypto.randomUUID(), instanceId: target.instanceId,
              actorUserId: target.ownerUserId })).instance) ?? {};
          },
          transitionRun: (expectedVersion) => transition({
            commandId: stableCommandId("kill-all-run-stopped", controlId),
            kind: "run_transition",
            runId: target.runId,
            ...(expectedVersion === undefined ? {} : { expectedVersion }),
            status: "stopped",
          }),
          transitionInstance: (expectedVersion, expectedRunId) => transition({
            commandId: stableCommandId("kill-all-instance-offline", controlId),
            kind: "instance_transition",
            instanceId: target.instanceId,
            ...(expectedVersion === undefined ? {} : { expectedVersion }),
            ...(expectedRunId === undefined ? {} : { expectedRunId }),
            status: "offline",
            terminal: true,
          }),
        } });
    },

    async issueHandoffStop(target, controlId, reason, channelId, handoffExport, timeoutMs) {
      await issueDaemonStop(target, controlId, reason, channelId, handoffExport);
      const result = await awaitDaemonStopResult(target, controlId, timeoutMs);
      if (!result) return { stopped: false };
      return { stopped: true, ...(record(result.handoffExport) ? { handoffExport: record(result.handoffExport)! } : {}) };
    },

    async stopResting(channelId, target) {
      const result = await runtime().stopRestingInstances({
        requestId: stableCommandId("resting-stop", `${input.sourceMessageId}:${target.mention ?? "all"}`),
        channelId, actorUserId: input.actorUserId,
        ...(target.mention ? { mention: target.mention } : {}),
        exclude: [...target.exclude],
      }) as Record<string, unknown>;
      const stopped = Array.isArray(result.stopped) ? result.stopped : [];
      return stopped.flatMap((raw) => {
        const value = record(raw);
        return typeof value?.instanceId === "string" && typeof value.mentionTarget === "string"
          ? [{ instanceId: value.instanceId, mentionTarget: value.mentionTarget }] : [];
      });
    },

    async publishSystemNotice(channelId, body, key) {
      const messageId = `system:${input.sourceMessageId}:kill-all${key ? `:${key}` : ""}`.slice(0, 200);
      const response = await retryTransientAuthorityResponse(() =>
        dispatchProductMessageAppend(input.env, channelId, {
          commandId: stableCommandId("kill-all-notice", messageId),
          messageId,
          channelId,
          body,
          principal,
          senderSnapshot: productAgentSystemNoticeSenderSnapshot(input.actorUserId),
          residual: {
            appMetadata: {
              // Stop summaries are control-plane facts. They must never become
              // fresh Human work when history is replayed to an Agent.
              xmatrixProvenance: "system_fact",
              xmatrixSystemNotice: true,
              sourceMessageId: input.sourceMessageId,
            },
          },
        }));
      const result = await payload(response);
      if (!response.ok) throw responseError("kill-all notice", response, result);
    },
  };
}

export async function dispatchProductAgentInterventionAfterAuthorityMessage(input: {
  env: Env;
  channelId: string;
  messageId: string;
  body: string;
  actorUserId: string;
}): Promise<ProductAgentInterventionResult | undefined> {
  if (!parseProductAgentStopCommand(input.body)) return undefined;
  return orchestrateProductAgentIntervention({
    channelId: input.channelId,
    sourceMessageId: input.messageId,
    body: input.body,
    port: createProductAgentInterventionAuthorityPort({
      env: input.env,
      actorUserId: input.actorUserId,
      sourceMessageId: input.messageId,
    }),
  });
}

/** Validated daemon stop targets from an Authority result that terminalized live Runs. */
export function daemonStopTargets(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const target = raw as Record<string, unknown>;
    const field = (name: string) => typeof target[name] === "string" ? target[name] as string : "";
    const required = ["instanceId", "runId", "agentId", "ownerUserId", "machineOwnerUserId", "machineId"]
      .map(field);
    if (required.some((entry) => !entry)) return [];
    const [instanceId, runId, agentId, ownerUserId, machineOwnerUserId, machineId] = required as [
      string, string, string, string, string, string,
    ];
    const hostId = field("hostname") || field("hostId");
    return [{
      instanceId, runId, agentId, ownerUserId, machineOwnerUserId, machineId, hostId,
      ...(field("executionKey") ? { executionKey: field("executionKey") } : {}),
    }];
  });
}

/**
 * After channel_archive_tree terminalizes Instances/Runs in Authority, issue the
 * durable Machine Daemon stop commands so host processes actually exit.
 * Failures are best-effort and logged; archive itself already committed.
 */
export async function issueDaemonStopsForArchivedChannelTree(input: {
  env: Env;
  actorUserId: string;
  rootChannelId: string;
  reason: string;
  targets: Array<{
    instanceId: string;
    runId: string;
    agentId: string;
    ownerUserId: string;
    machineOwnerUserId: string;
    machineId: string;
    hostId: string;
    executionKey?: string;
  }>;
}): Promise<{ issued: number; failures: string[] }> {
  if (input.targets.length === 0) return { issued: 0, failures: [] };
  const port = createProductAgentInterventionAuthorityPort({
    env: input.env,
    actorUserId: input.actorUserId,
    sourceMessageId: `archive:${input.rootChannelId}`,
  });
  const failures: string[] = [];
  let issued = 0;
  await Promise.all(input.targets.map(async (target, index) => {
    const controlId = `archive-stop:${input.rootChannelId}:${target.instanceId}:${index}`.slice(0, 200);
    try {
      await port.issueStop(
        {
          instanceId: target.instanceId,
          runId: target.runId,
          agentId: target.agentId,
          mentionTarget: target.instanceId,
          ownerUserId: target.ownerUserId,
          machineOwnerUserId: target.machineOwnerUserId,
          machineId: target.machineId,
          hostId: target.hostId,
          ...(target.executionKey ? { executionKey: target.executionKey } : {}),
        },
        controlId,
        input.reason,
      );
      issued += 1;
    } catch (error) {
      failures.push(
        `${target.instanceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }));
  if (failures.length > 0) {
    console.error("Channel archive daemon stop failures", {
      rootChannelId: input.rootChannelId,
      failures,
    });
  }
  return { issued, failures };
}

/**
 * An Agent run leaving the Channel it is bound to ends that run. The run has
 * no other Channel to live in, so an acknowledged leave that kept the process
 * running would be a false success. It takes the `@agent:kill` path: the
 * run's own live kill target receives a Machine Daemon stop, and the Channel
 * reads a notice saying who left.
 */
export async function stopAgentRunLeavingChannel(
  env: Env,
  run: Pick<AgentRunPrincipal, "channelId" | "ownerUserId" | "runId">,
  channelId: string,
): Promise<{ status: 200 | 403 | 404; body: Record<string, unknown> }> {
  if (channelId !== run.channelId) {
    return { status: 403, body: { error: "An Agent run can only leave the Channel it runs in",
      code: "agent_run_channel_mismatch" } };
  }
  const port = createProductAgentInterventionAuthorityPort({
    env,
    actorUserId: run.ownerUserId,
    sourceMessageId: `leave:${run.runId}`,
  });
  const target = (await port.listKillTargets(channelId))
    .find((candidate) => candidate.runId === run.runId);
  if (!target) {
    return { status: 404, body: { error: "This Agent run is not live in the Channel",
      code: "agent_run_not_live" } };
  }
  await port.issueStop(
    target,
    `leave:${channelId}:${target.instanceId}`.slice(0, 200),
    `@${target.mentionTarget} left the channel`,
    channelId,
  );
  await port.publishSystemNotice(channelId, `@${target.mentionTarget} left the channel.`);
  return { status: 200, body: { ok: true, stopping: true, agent: target.mentionTarget } };
}
