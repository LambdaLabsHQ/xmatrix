import {
  PostgresMachineRunTerminalReportRepository,
  PostgresPageRepository,
  type AuthorityDatabase,
  type MachineRunTerminalReport,
} from "@xmatrix/db";

import { machineDaemonCommandPrincipal } from "./connections/machine-daemon/auth";
import { machineRunLifecycleReport } from "./machine-run-lifecycle-report";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { relayRuntimeCellsForOwners } from "./relay-authority-locator";
import { RELAY_RUNTIME_AGENT_TRACE_TERMINATE_PATH } from "./runtime-transport/relay-runtime-product-adapter";
import type { Env } from "./types";

type TerminalReportRepository = Pick<PostgresMachineRunTerminalReportRepository,
  "pruneFinalized" | "claim" | "settle">;

/** Every effect finalizing one report has, in the order it runs them. */
export interface MachineRunTerminalPort {
  /** Commits the Space-scoped Run lifecycle; returns the lifecycle result. */
  commitLifecycle(report: MachineRunTerminalReport): Promise<Record<string, unknown>>;
  /** Closes the Runtime socket of an Instance the lifecycle made terminal. */
  terminateInstance(instanceId: string, ownerUserId: string): Promise<void>;
  /** Ends the page claims ended Instances held in the Run's conversation: a claim lives as long as its Run. */
  endInstanceClaims(conversationId: string, instanceIds: string[]): Promise<void>;
}


async function finalizeReport(report: MachineRunTerminalReport, port: MachineRunTerminalPort): Promise<void> {
  const lifecycle = await port.commitLifecycle(report);
  // Only the committed lifecycle names which Instances ended; an Agent that
  // never unregistered would otherwise keep its socket and presence.
  const terminal = lifecycle.terminalInstanceIds === undefined ? [] : lifecycle.terminalInstanceIds;
  if (!Array.isArray(terminal) || terminal.length > 10_000 ||
      terminal.some(id => typeof id !== "string" || !id || id.length > 300)) {
    throw new Error("Invalid authoritative terminal Instance list");
  }
  for (const instanceId of terminal as string[]) {
    await port.terminateInstance(instanceId, report.ownerUserId);
  }
  if (terminal.length > 0 && report.channelId) await port.endInstanceClaims(report.channelId, terminal as string[]);
}

/**
 * One coordinator pass over committed terminal reports. A report is settled
 * finalized only after every step succeeded; a failure retries it with backoff
 * and never blocks the others. Every step is idempotent, so a retry replays
 * what already committed. Returns how many reports it finalized.
 */
export async function finalizeMachineRunTerminalReportsWith(
  repository: TerminalReportRepository, port: MachineRunTerminalPort, channelId: string,
): Promise<number> {
  await repository.pruneFinalized(channelId);
  const claimed = await repository.claim(`machine-run-terminal:${crypto.randomUUID()}`, channelId);
  const outcomes = await Promise.all(claimed.map(async (report) => {
    try {
      await finalizeReport(report, port);
      await repository.settle({ report, finalized: true });
      return true;
    } catch (error) {
      const errorCode = error instanceof Error ? error.message : String(error);
      console.warn("Machine Run terminal finalization deferred", {
        runId: report.runId, eventType: report.eventType, attempts: report.attempts, errorCode,
      });
      await repository.settle({ report, finalized: false, errorCode });
      return false;
    }
  }));
  return outcomes.filter(Boolean).length;
}

/** Production port; the coordinator passes its full Worker environment. */
export function machineRunTerminalPort(env: Env): MachineRunTerminalPort {
  return {
    async commitLifecycle(report) {
      const principal = { ownerUserId: report.ownerUserId, ownerEmail: report.ownerEmail,
        machineId: report.machineId, hostId: report.hostId,
        ...(report.hostName ? { hostName: report.hostName } : {}) };
      return machineRunLifecycleReport(env, {
        // The exact (Run, event) names the command, so a retry replays it.
        commandId: `machine-run-terminal:${report.eventType}:${report.runId}`.slice(0, 300),
        action: "report", eventType: report.eventType, ...principal,
        connectionEpoch: report.connectionEpoch, metadata: {}, capabilities: [],
        payload: report.payload, channelId: report.channelId,
        ...(report.stopPurpose ? { runLifecycleStopPurpose: report.stopPurpose } : {}),
        principal: machineDaemonCommandPrincipal(principal),
      });
    },
    async terminateInstance(instanceId, ownerUserId) {
      const url = new URL(RELAY_RUNTIME_AGENT_TRACE_TERMINATE_PATH, "https://relay-runtime.internal");
      url.searchParams.set("instanceId", instanceId);
      url.searchParams.set("reason", "ended_on_host");
      const responses = await Promise.all(relayRuntimeCellsForOwners(env, [ownerUserId])
        .map((cell) => cell.fetch(new Request(url, { method: "POST" }))));
      const failed = responses.find((response) => !response.ok);
      if (failed) throw new Error(`instance terminal notification ${failed.status}`);
    },
    async endInstanceClaims(conversationId, instanceIds) {
      // Best effort: a claim it misses still runs out its lease, so it never holds the Run's finalization back.
      await new PostgresPageRepository(createPostgresAuthorityDatabase(env, {
        applicationName: "xmatrix-run-claims", statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
      })).endInstanceClaims({ requestId: crypto.randomUUID(), conversationId, instanceIds })
        .catch((error: unknown) => console.warn("ended Instances' page claims not ended", error));
    },
  };
}

export function finalizeMachineRunTerminalReports(env: Env, database: AuthorityDatabase, channelId: string): Promise<number> {
  return finalizeMachineRunTerminalReportsWith(
    new PostgresMachineRunTerminalReportRepository(database), machineRunTerminalPort(env), channelId);
}
