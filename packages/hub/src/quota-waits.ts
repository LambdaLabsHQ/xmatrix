import type { SpaceAgentRegistrationKey } from "@xmatrix/protocol";
import {
  owedRegistrationQuotaWaitOwners, PostgresChannelSpaceDirectory, PostgresQuotaRetryRepository,
  PostgresSpacePlacementDirectory, readyRegistrationQuotaWaits, RegistrationAccessError, registrationQuotaProbeTargets,
  settleRegistrationQuotaWaits, waitedRegistrationsOnMachine, waitForRegistrationQuota,
  type AuthorityDatabase, type ReadyRegistrationQuotaWait,
} from "@xmatrix/db";
import { runtimePlacement } from "./runtime";
import { issueRegistrationQuotaProbes, type QuotaProbeIssueDependencies } from "./agent-routing-quota-refresh";
import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import type { Env } from "./types";

/**
 * Quota waits: how a summon refused because its provider quota read as used
 * up starts on its own once quota is back, with no timer and no repeated
 * summon.
 *
 * A refusal records a wait on the pools it rested on, fenced by the reading
 * that refused, and asks each pool's daemon for one fresh read. The
 * transaction that records any later reading with headroom for a pool (that
 * read, an Instance's own report, any other read) marks the wait ready, so the
 * event cannot be lost. Delivery makes the Channel's quota retries due and
 * wakes its launch coordinator, whose full admission decides; a wait is
 * deleted only once its Channel was told. A delivery that failed is made
 * again on the owner's next reading or by the minute's recovery, which reads
 * the database only and never asks a provider.
 */

/** How long an original summon counts as still being checked: a reading
 * that clears it within this window starts it without a choice. */
export const QUOTA_VERIFY_WINDOW_MS = 60_000;
/** A wait lasts as long as the quota retry it serves. */
const QUOTA_WAIT_LIFETIME_MS = 35 * 24 * 60 * 60_000;
/** A ready wait not delivered after this long was missed by its reading's
 * own delivery and is delivered again. */
const QUOTA_WAIT_REDELIVERY_MS = 30_000;
const QUOTA_WAIT_DELIVERY_CONCURRENCY = 4;

/** The quota retries of the Space a Channel is placed in. */
export async function quotaRetryRepository(env: Env, channelId: string, database?: AuthorityDatabase) {
  const authorities = runtimePlacement(env);
  const route = await new PostgresChannelSpaceDirectory(authorities.directory).resolve(
    { requestId: crypto.randomUUID(), operation: "quota-retry.locate" },
    channelId,
  );
  if (!route) throw new RegistrationAccessError("channel_not_found", 404);
  const placement = await new PostgresSpacePlacementDirectory(authorities.directory).resolve(
    { requestId: crypto.randomUUID(), operation: "quota-retry.placement" },
    route.spaceId,
  );
  if (placement.state !== "active") throw new RegistrationAccessError("registration_placement_unavailable", 503);
  return {
    repository: new PostgresQuotaRetryRepository(database ?? authorities.database, placement),
    placement,
    ...authorities,
  };
}

/**
 * A summon in `channelId` was refused because these registrations' quota read
 * as used up, resting on the reading `refusedThrough`. Record the wait; when
 * a newer reading with headroom is already in, deliver it now, and otherwise
 * (for an original summon) ask each refused registration's daemon for one
 * fresh read, joining one already under way.
 */
export async function waitAfterQuotaRefusal(env: Env, input: {
  channelId: string; registrations: readonly SpaceAgentRegistrationKey[]; refusedThrough: string; verify: boolean;
}, dependencies: QuotaWaitDependencies = {}): Promise<void> {
  const { directory } = runtimePlacement(env);
  const ready = await waitForRegistrationQuota(directory, { channelId: input.channelId,
    registrations: input.registrations, refusedThrough: input.refusedThrough,
    expiresAt: new Date(Date.now() + QUOTA_WAIT_LIFETIME_MS).toISOString(), requestId: crypto.randomUUID() });
  if (ready) {
    for (const owner of new Set(input.registrations.map(key => key.ownerUserId))) {
      await deliverQuotaWakes(env, owner, dependencies);
    }
    return;
  }
  if (input.verify) await verifyRegistrationQuota(env, { registrations: input.registrations,
    readAfter: input.refusedThrough }, dependencies);
}

export type QuotaWaitDependencies = QuotaProbeIssueDependencies & {
  /** Wake a Channel's launch coordinator; the production binding by default. */
  wakeCoordinator?: (channelId: string) => Promise<void>;
  /** The quota retries of a Channel's Space; PostgreSQL by default. */
  retries?: (channelId: string) => Promise<Pick<PostgresQuotaRetryRepository, "wake">>;
  /** Ready waits and their settlement; the directory database by default. */
  waits?: {
    ready(ownerUserId: string): Promise<ReadyRegistrationQuotaWait[]>;
    settle(waits: readonly ReadyRegistrationQuotaWait[]): Promise<void>;
    owedOwners(): Promise<string[]>;
  };
};

function quotaWaitStore(env: Env, dependencies: QuotaWaitDependencies) {
  if (dependencies.waits) return dependencies.waits;
  const { directory } = runtimePlacement(env);
  return {
    ready: (ownerUserId: string) => readyRegistrationQuotaWaits(directory, { ownerUserId, requestId: crypto.randomUUID() }),
    settle: (waits: readonly ReadyRegistrationQuotaWait[]) =>
      settleRegistrationQuotaWaits(directory, { waits, requestId: crypto.randomUUID() }),
    owedOwners: () => owedRegistrationQuotaWaitOwners(directory, { olderThanMs: QUOTA_WAIT_REDELIVERY_MS,
      limit: 50, requestId: crypto.randomUUID() }),
  };
}

/**
 * Ask the daemon of each registration for one fresh read of its quota that
 * must be newer than `readAfter`. One probe per target, so a slow provider
 * holds back no other; a read of the same target already under way on the
 * same daemon connection answers this one too (see machine control).
 */
export async function verifyRegistrationQuota(env: Env, input: {
  registrations: ReadonlyArray<{ ownerUserId: string; machineId: string; harness: string }>; readAfter: string;
}, dependencies: QuotaProbeIssueDependencies = {}): Promise<{ issued: number }> {
  const { directory } = runtimePlacement(env);
  const entries = await registrationQuotaProbeTargets(directory, { requestId: crypto.randomUUID(),
    registrations: input.registrations.map(({ ownerUserId, machineId, harness }) => ({ ownerUserId, machineId, harness })) });
  return issueRegistrationQuotaProbes({ env, directory, entries, fresh: { readAfter: input.readAfter } }, dependencies);
}

/**
 * Deliver the owner's ready waits: each Channel's waiting and still-verifying
 * quota retries become due and its coordinator is woken, then the waits are
 * settled by the token they were read with. A Channel that no longer exists
 * has nothing to wake; any other failure keeps its waits for redelivery.
 */
export async function deliverQuotaWakes(env: Env, ownerUserId: string,
  dependencies: QuotaWaitDependencies = {}): Promise<{ delivered: number }> {
  const store = quotaWaitStore(env, dependencies);
  const waits = await store.ready(ownerUserId);
  const byChannel = new Map<string, ReadyRegistrationQuotaWait[]>();
  for (const wait of waits) byChannel.set(wait.channelId, [...byChannel.get(wait.channelId) ?? [], wait]);
  const channels = [...byChannel.entries()];
  let next = 0, delivered = 0;
  const wake = dependencies.wakeCoordinator ?? (channelId => wakeAgentLaunchCoordinator(env, channelId, ["quotaRetry"]));
  const retries = dependencies.retries ?? (async (channelId: string) => (await quotaRetryRepository(env, channelId)).repository);
  async function worker() {
    while (next < channels.length) {
      const [channelId, channelWaits] = channels[next++]!;
      try {
        if (await (await retries(channelId)).wake(channelId)) await wake(channelId);
      } catch (error) {
        if (!(error instanceof RegistrationAccessError && error.code === "channel_not_found")) {
          console.warn("Quota wait delivery failed; it is delivered again", {
            error: error instanceof Error ? error.message : String(error) });
          continue;
        }
      }
      await store.settle(channelWaits);
      delivered += channelWaits.length;
    }
  }
  await Promise.all(Array.from({ length: Math.min(QUOTA_WAIT_DELIVERY_CONCURRENCY, channels.length) }, worker));
  return { delivered };
}

/** Deliver again what a reading's own delivery missed. Reads and writes the
 * database only: it never asks a daemon or a provider. */
export async function redeliverOwedQuotaWakes(env: Env, dependencies: QuotaWaitDependencies = {}): Promise<void> {
  for (const owner of await quotaWaitStore(env, dependencies).owedOwners()) {
    await deliverQuotaWakes(env, owner, dependencies);
  }
}

/** A machine's daemon connected: read again the quota a refused summon is
 * waiting on there, which nothing could read while it was offline. */
export async function verifyWaitedQuotaOnMachine(env: Env, input: { ownerUserId: string; machineId: string },
  dependencies: QuotaProbeIssueDependencies = {}): Promise<void> {
  const { directory } = runtimePlacement(env);
  const registrations = await waitedRegistrationsOnMachine(directory, { ...input, requestId: crypto.randomUUID() });
  if (registrations.length) await verifyRegistrationQuota(env, { registrations,
    readAfter: new Date(Date.now() - 1).toISOString() }, dependencies);
}
