import {
  AGENT_QUOTA_RETRY_NOTICE_KIND,
  routingQuotaObservation,
  routingQuotaResetTime,
  type SpaceAgentRegistrationKey,
} from "@xmatrix/protocol";
import {
  PostgresMessageRepository,
  RegistrationAccessError,
  ControlError,
  readRegistrationQuotaExpiries,
  readRegistrationQuotaState,
  registrationQuotaKey,
  type AuthorityDatabase,
  type QuotaRetryWork,
} from "@xmatrix/db";
import { runtimeRepository, jevEvaluator } from "./runtime";
import { quotaRetryRepository, verifyRegistrationQuota, waitAfterQuotaRefusal } from "./quota-waits";
import {
  dispatchProductAgentSystemNotice,
  productAgentSystemNoticeId,
} from "./product-agent-mention-authority-adapter";
import { postgresProductMessage } from "./postgres-message-authority";
import { executeRegistrationLaunchDispatch, prepareRegistrationReborn } from "./registration-launch-dispatch";
import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import type { Env } from "./types";
import type { HandoffSuccessor } from "./handoff-successor";
async function quotaSourceMessage(input: {
  database: AuthorityDatabase; spaceId: string; channelId: string; actorUserId: string; messageId: string; sequence?: number;
}) {
  let sequence = input.sequence;
  if (sequence === undefined) {
    const [source] = await input.database.transaction({ requestId: crypto.randomUUID(), operation: "quota-retry.source-sequence" },
      tx => tx.query<{ timeline_sequence: string }>({ name: "quota_retry_source_sequence_v1",
        text: `SELECT timeline_sequence FROM data.messages WHERE space_id=$1 AND channel_id=$2 AND message_id=$3
          AND deleted_at IS NULL AND recalled_at IS NULL`, values: [input.spaceId,input.channelId,input.messageId],maxRows:1 }));
    if (!source) return undefined;
    sequence = Number(source.timeline_sequence);
  }
  // The existing content authority checks the reader and hydrates the private
  // immutable payload. A directory lookup never substitutes for that read.
  const page = await new PostgresMessageRepository(input.database).history({
    requestId: crypto.randomUUID(),spaceId: input.spaceId,channelId: input.channelId,
    principal: { kind:"user",id:input.actorUserId },beforeSequence:sequence+1,limit:1,
  });
  return page.messages.map(postgresProductMessage).find(message => message.messageId === input.messageId);
}
export { quotaRetryRepository };
/** A failed handoff may offer waiting, but never schedules it. The stopped
 * source keeps its own session; a successful successor suppresses this offer. */
export async function offerUsageLimitRecovery(env: Env, input: HandoffSuccessor): Promise<void> {
  const { repository, database, directory, placement } = await quotaRetryRepository(env, input.channelId);
  await runtimeRepository(env).launchChannelSpace({
    requestId: crypto.randomUUID(),
    channelId: input.channelId,
    actorUserId: input.actorUserId,
  });
  const [binding] = await database.transaction(
    {
      requestId: crypto.randomUUID(),
      operation: "quota-retry.handoff-source",
      placement,
    },
    async (tx) => {
      return tx.query<{
        space_id: string;
        owner_user_id: string;
        machine_id: string;
        harness: string;
      }>({
        name: "quota_retry_handoff_binding_v1",
        text: `SELECT b.space_id,b.owner_user_id,b.machine_id,b.harness
      FROM data.run_agent_registrations b JOIN data.runs r ON r.run_id=b.run_id JOIN data.instances i ON i.run_id=r.run_id
      WHERE r.channel_id=$1 AND r.run_id=$2 AND i.instance_id=$3 AND r.owner_user_id=$4
        AND NOT EXISTS(SELECT 1 FROM data.agent_launches l WHERE l.channel_id=$1 AND l.trigger_id=$5)`,
        values: [input.channelId, input.sourceRunId, input.sourceInstanceId, input.actorUserId, input.sourceMessageId],
        maxRows: 1,
      });
    },
  );
  if (!binding) return;
  const key: SpaceAgentRegistrationKey = {
    spaceId: binding.space_id,
    ownerUserId: binding.owner_user_id,
    machineId: binding.machine_id,
    harness: binding.harness,
  };
  const quota = (await readRegistrationQuotaState(directory, [key], crypto.randomUUID())).get(
    registrationQuotaKey(key),
  );
  if (!quota || (quota.quotaState !== "exhausted" && !quota.quotaUsages?.some((w) => (w.percent ?? 0) >= 100))) return;
  // The hold or reading that stopped the Instance: only a newer reading is news.
  const refusedThrough = quota.quotaObservedAt ?? new Date().toISOString();
  const id = await repository.offer({
    channelId: input.channelId,
    actorUserId: input.actorUserId,
    sourceMessageId: input.sourceMessageId,
    sourceMention: input.sourceMention ?? input.sourceAddress,
    selectionIndex: 0,
    registrations: [key],
    continuation: {
      instanceId: input.sourceInstanceId,
      runId: input.sourceRunId,
    },
    refusedThrough,
  });
  // Recovering a stopped Instance stays its author's choice: the wait only
  // wakes the retry once they chose it, and asks no read of its own.
  await waitAfterQuotaRefusal(env, { channelId: input.channelId, registrations: [key], refusedThrough, verify: false })
    .catch((error: unknown) => console.warn("Quota wait after a usage limit failed", {
      error: error instanceof Error ? error.message : String(error) }));
  const source = { database,spaceId:placement.spaceId,channelId:input.channelId,actorUserId:input.actorUserId };
  const handoff = await quotaSourceMessage({ ...source,messageId:input.sourceMessageId });
  const metadata = handoff?.metadata as Record<string,unknown> | undefined;
  const failure = metadata?.xmatrixUsageLimitHandoff === true && typeof metadata.sourceMessageId === "string"
    ? await quotaSourceMessage({ ...source,messageId:metadata.sourceMessageId }) : undefined;
  const failureMetadata = failure?.metadata as Record<string,unknown> | undefined;
  const sender = failure?.from as Record<string,unknown> | undefined;
  const original = failureMetadata?.xmatrixTurnFailure === true && sender?.instanceId === input.sourceInstanceId
    && typeof failure?.body === "string" ? failure.body : undefined;
  await dispatchProductAgentSystemNotice({
    env,
    actorUserId: input.actorUserId,
    channelId: input.channelId,
    sourceMessageId: input.sourceMessageId,
    body: [original,"No Agent could take over this task. You can wait for its provider quota to recover and retry automatically."]
      .filter(Boolean).join("\n\n"),
    metadata: { kind: AGENT_QUOTA_RETRY_NOTICE_KIND, xmatrixQuotaRetryId: id },
  });
}
/** Readiness is a provider observation newer than the reading that refused
 * (or, for a retry from before that was recorded, than the refusal). The
 * expiry of a routing hold, an offline daemon or an unavailable probe never
 * proves quota. A retry not ready is checked next when its blocking windows
 * reset, or when the hold it waits behind ends; with neither known it waits
 * for an event (a reading, a reconnect) rather than a time. */
async function quotaRetryReadiness(
  directory: AuthorityDatabase,
  row: QuotaRetryWork,
): Promise<{ ready: boolean; nextCheckAt: number | null; fence: string }> {
  const keys = row.registrations_json;
  const [quotas, expiries] = await Promise.all([
    readRegistrationQuotaState(directory, keys, crypto.randomUUID()),
    readRegistrationQuotaExpiries(directory, keys, crypto.randomUUID()),
  ]);
  const now = Date.now();
  const fence = row.refused_through ? new Date(row.refused_through) : new Date(row.created_at);
  const newer = (observedAt: string) => row.refused_through
    ? Date.parse(observedAt) > fence.getTime() : Date.parse(observedAt) >= fence.getTime();
  const candidates = keys.map((key) => {
    const q = quotas.get(registrationQuotaKey(key));
    const ready =
      q?.quotaState === "observed" &&
      q.quotaObservedAt !== undefined &&
      newer(q.quotaObservedAt) &&
      (routingQuotaObservation(q, now)?.value ?? 0) > 0;
    // All blocking windows must have provider timestamps; a hold names none,
    // so its end is when it is read again.
    const blockers = q?.quotaUsages?.filter((window) => (window.percent ?? 0) >= 100) ?? [];
    const resets = blockers.map((window) => routingQuotaResetTime(window.resetAt));
    const known = resets.length > 0 && resets.every((time) => Number.isFinite(time) && time > now);
    const holdEnds = Date.parse(expiries.get(registrationQuotaKey(key)) ?? "");
    return { ready, nextCheckAt: known ? Math.max(...resets) + 1_000
      : q?.quotaState === "exhausted" && Number.isFinite(holdEnds) && holdEnds > now ? holdEnds + 1_000 : null };
  });
  const times = candidates.flatMap((candidate) => candidate.nextCheckAt === null ? [] : [candidate.nextCheckAt]);
  return {
    ready: candidates.some((candidate) => candidate.ready),
    nextCheckAt: times.length ? Math.min(Date.parse(String(row.expires_at)), ...times) : null,
    fence: fence.toISOString(),
  };
}
async function retryLaunch(
  env: Env,
  channelId: string,
  row: QuotaRetryWork,
  admission: {
    id: string;
    generation: number;
  },
  database: AuthorityDatabase,
) {
  const { placement, directory } = await quotaRetryRepository(env, channelId, database);
  const message = await quotaSourceMessage({ database,spaceId:placement.spaceId,channelId,
    actorUserId:row.actor_user_id,messageId:row.source_message_id,sequence:Number(row.source_sequence) });
  if (!message || typeof message.body !== "string")
    throw new RegistrationAccessError("invocation_source_unavailable", 409);
  const evaluatorFor = jevEvaluator(env, {
    feature: "launch_choice",
    actorUserId: row.actor_user_id,
    channelId,
    sourceMessageId: row.source_message_id,
    invocationId: row.retry_id,
  });
  if (!evaluatorFor) throw new RegistrationAccessError("registration_selection_unconfigured", 503);
  const result = await executeRegistrationLaunchDispatch({
    env,
    database,
    directory,
    evaluatorFor,
    channelId,
    actorUserId: row.actor_user_id,
    commandId: `quota-retry:${row.retry_id}:${row.generation}`,
    sourceMessageId: row.source_message_id,
    body: message.body,
    forceMention: row.source_mention,
    onlySelectionIndex: row.selection_index,
    quotaRetry: admission,
  });
  if (!result.prepared.length) {
    const refusal = result.quotaRefusals[0];
    throw new RegistrationAccessError(result.rejected[0]?.code ?? "registration_source_changed", 409,
      undefined, undefined, undefined, refusal?.registrations, refusal?.refusedThrough);
  }
  await wakeAgentLaunchCoordinator(env, channelId, ["launch"]);
}
export async function reconcileQuotaRetries(env: Env, database: AuthorityDatabase, channelId: string): Promise<void> {
  const { repository, directory } = await quotaRetryRepository(env, channelId, database);
  for (const row of await repository.due(channelId)) {
    try {
      if (row.kind === "continuation") {
        // A lost acknowledgement can follow the durable reborn commit (and
        // even its Instance rebind). Reconcile that exact continuation before
        // considering any new attempt or reading its predecessor again.
        const [own] = await database.transaction(
          { requestId: crypto.randomUUID(), operation: "quota-retry.continuation-replay" },
          (tx) =>
            tx.query<{ state: string }>({
              name: "quota_retry_own_continuation_v1",
              text: `SELECT state FROM data.agent_reborn_intents WHERE channel_id=$1
              AND source_instance_id=$2 AND source_run_id=$3 AND run_input_json->'quotaRetry'->>'id'=$4
              AND (run_input_json->'quotaRetry'->>'generation')::integer=$5 LIMIT 1`,
              values: [channelId, row.source_instance_id, row.source_run_id, row.retry_id, row.generation],
              maxRows: 1,
            }),
        );
        if (own) {
          if (own.state !== "failed") await wakeAgentLaunchCoordinator(env, channelId, ["reborn"]);
          await repository.settle(channelId, row, own.state === "failed" ? "failed" : "dispatched");
          continue;
        }
      }
      const readiness =
        row.state === "dispatching"
          ? { ready: true, nextCheckAt: Date.now() }
          : await quotaRetryReadiness(directory, row);
      if (!readiness.ready) {
        // Not ready at its time: ask for one fresh read of its own pools,
        // newer than what refused it. The reading wakes it through its wait.
        if ("fence" in readiness) {
          await verifyRegistrationQuota(env, { registrations: row.registrations_json, readAfter: readiness.fence })
            .catch((error: unknown) => console.warn("Quota retry verification failed", {
              error: error instanceof Error ? error.message : String(error) }));
        }
        await repository.settle(channelId, row, "waiting", readiness.nextCheckAt);
        continue;
      }
      const admission = await repository.dispatch({ channelId, row });
      if (row.kind === "launch") await retryLaunch(env, channelId, row, admission, database);
      else {
        const body = "Provider quota is available. Resuming the interrupted task from its existing session.";
        const sourceMessageId = await productAgentSystemNoticeId(row.retry_id, channelId, body);
        await dispatchProductAgentSystemNotice({
          env,
          channelId,
          actorUserId: row.actor_user_id,
          sourceMessageId: row.retry_id,
          body,
        });
        await prepareRegistrationReborn(env, {
          commandId: `quota-retry:${row.retry_id}:${row.generation}`,
          actorUserId: row.actor_user_id,
          channelId,
          sourceMessageId,
          sourceInstanceId: row.source_instance_id!,
          quotaRetry: admission,
          prompt: "Continue where you left off. Check whether your last action completed before repeating it.",
        });
        await wakeAgentLaunchCoordinator(env, channelId, ["reborn"]);
      }
      await repository.settle(channelId, row, "dispatched");
    } catch (error) {
      if (!(error instanceof ControlError) || error.status >= 500) throw error;
      const waits = error.code === "registration_quota_exhausted" || error.code === "registration_daemon_offline";
      // Refused again: it waits for news it has not seen. For used-up quota
      // that is a reading newer than the one the launch just rested on (a
      // model's own pool may be used up while the account's is not); for an
      // offline daemon, a reading taken after it reconnects.
      const refusedThrough = error instanceof RegistrationAccessError && error.code === "registration_quota_exhausted"
        ? error.quotaRefusedThrough ?? new Date().toISOString() : new Date().toISOString();
      await repository.settle(
        channelId,
        row,
        waits ? "waiting" : error.code === "quota_retry_cancelled" ? "cancelled" : "failed",
        null, error.code, waits ? refusedThrough : undefined,
      );
      if (waits) {
        await waitAfterQuotaRefusal(env, { channelId, registrations: row.registrations_json, refusedThrough, verify: false })
          .catch((waitError: unknown) => console.warn("Quota retry wait failed", {
            error: waitError instanceof Error ? waitError.message : String(waitError) }));
      }
    }
  }
}
