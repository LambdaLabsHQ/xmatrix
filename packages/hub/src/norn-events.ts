import { PostgresNornProgramRepository, readWaitingNornPrograms } from "@xmatrix/db";
import { sha256Hex } from "@xmatrix/protocol";
import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import { isNornStream, nornStep, type NornStream } from "./norn-host";
import { createPostgresAuthorityFleet } from "./postgres-authority-fleet";
import { postgresMessageRoute } from "./postgres-message-authority";
import type { Env } from "./types";
import type { CloudEventInput } from "./vendor/norn/runtime/ledger";

/**
 * An outside event reaches the Norn programs that wait for it
 * (docs/architecture/norn-host.md): each running program whose last pass
 * left it waiting on a matching stream, and which `allowed` lets hear it, has
 * the event recorded in its ledger and is evaluated at once. Returns how many
 * programs heard it.
 */
export async function occurNornEvent(env: Env, input: { id: string; spaceId?: string; what: string;
  cloudEvent?: CloudEventInput;
  matches: (stream: NornStream) => boolean;
  allowed?: (program: { spaceId: string; authorityUserId: string }) => Promise<boolean> }): Promise<number> {
  let heard = 0;
  const id = await sha256Hex(input.id);
  for (const shard of createPostgresAuthorityFleet(env, { applicationName: "xmatrix-norn-events", statementTimeoutMs: 5_000,
    transactionTimeoutMs: 15_000, lockTimeoutMs: 2_000 }).physicalShards) {
    const programs = await readWaitingNornPrograms(shard.database, { requestId: crypto.randomUUID(),
      ...(input.spaceId ? { spaceId: input.spaceId } : {}) });
    for (const program of programs) {
      const streams = program.waits.filter(isNornStream).filter(input.matches);
      if (!streams.length || (input.allowed && !await input.allowed(program))) continue;
      const requestId = `norn-event:${id}:${program.programId}`;
      const repository = new PostgresNornProgramRepository(shard.database,
        await postgresMessageRoute(env, program.channelId, requestId, { database: shard.database }));
      await repository.advance({ requestId, channelId: program.channelId, programId: program.programId },
        nornStep(undefined, { id, streams, what: input.what, ...(input.cloudEvent ? { cloudEvent: input.cloudEvent } : {}) }));
      await wakeAgentLaunchCoordinator(env, program.channelId, ["norn"]);
      heard++;
    }
  }
  return heard;
}
