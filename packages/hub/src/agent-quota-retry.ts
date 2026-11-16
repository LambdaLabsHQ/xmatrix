import {
  AGENT_QUOTA_RETRY_NOTICE_KIND,
  routingQuotaObservation,
  type QuotaRetryModel,
  type QuotaRetryRegistration,
} from "@xmatrix/protocol";
import {
  PostgresMessageRepository,
  RegistrationAccessError,
  ControlError,
  readRegistrationQuotaUsages,
  registrationQuotaKey,
  type AuthorityDatabase,
  type QuotaRetryWork,
  type RegistrationQuotaUsage,
} from "@xmatrix/db";
import { runtimeRepository, jevEvaluator } from "./runtime";
import { quotaRetryRepository, waitAfterQuotaRefusal } from "./quota-waits";
import {
  dispatchProductAgentSystemNotice,
  productAgentSystemNoticeId,
} from "./product-agent-mention-authority-adapter";
import { postgresProductMessage } from "./postgres-message-authority";
import { executeRegistrationLaunchDispatch, prepareRegistrationReborn, readContinuationModelFacts } from "./registration-launch-dispatch";
import { quotaRecoveryModel } from "./registration-launch-choice";
import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import type { Env } from "./types";
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

/** The headroom a quota retry's model has on one registration's reading: the
 * account windows and the scoped windows of the model's `quotaScopes`. */
function retryModelQuota(usage: RegistrationQuotaUsage | undefined, model: QuotaRetryModel | undefined, now: number) {
  return routingQuotaObservation(usage, now, model ? { model } : undefined);
}

/** A stopped Instance's turn whose quota is used up, offered to resume once it is back. */
export interface UsageLimitRecovery {
  channelId: string; actorUserId: string;
  /** The handoff that found no successor, or the turn-failure notice itself
   * when no handoff was tried (a used-up model). */
  sourceMessageId: string;
  /** `@name:<n>` as the Channel addresses the source. */
  sourceMention: string;
  sourceRunId: string; sourceInstanceId: string;
  /** The model the stopped turn ran, when its own quota (not the account's) ran out. */
  model?: QuotaRetryModel;
}

/** Offer to resume a stopped Instance once its quota is back: after a handoff
 * found no successor for a used-up account, or at once for a used-up model.
 * The offer never schedules work; a successful successor suppresses it. */
export async function offerUsageLimitRecovery(env: Env, input: UsageLimitRecovery): Promise<void> {
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
  const key: QuotaRetryRegistration = {
    spaceId: binding.space_id,
    ownerUserId: binding.owner_user_id,
    machineId: binding.machine_id,
    harness: binding.harness,
    ...(input.model ? { model: input.model } : {}),
  };
  const now = Date.now();
  const usage = (await readRegistrationQuotaUsages(directory, [key], crypto.randomUUID())).get(registrationQuotaKey(key));
  const quota = retryModelQuota(usage, input.model, now);
  // A handoff that found no successor offers to wait only on quota read as
  // used up. A turn refused for its model's quota is offered the retry
  // whatever a newer reading says: its readiness settles it.
  if (!input.model && (!quota || quota.value > 0)) return;
  // The hold or reading that stopped the Instance: only a newer reading is news.
  const refusedThrough = quota?.observedAt ?? new Date(now).toISOString();
  const id = await repository.offer({
    channelId: input.channelId,
    actorUserId: input.actorUserId,
    sourceMessageId: input.sourceMessageId,
    sourceMention: input.sourceMention,
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
  const offered = await quotaSourceMessage({ ...source,messageId:input.sourceMessageId });
  const metadata = offered?.metadata as Record<string,unknown> | undefined;
  // The turn-failure notice: the source itself, or the one a handoff names.
  const failure = metadata?.xmatrixUsageLimitHandoff === true && typeof metadata.sourceMessageId === "string"
    ? await quotaSourceMessage({ ...source,messageId:metadata.sourceMessageId }) : offered;
  const failureMetadata = failure?.metadata as Record<string,unknown> | undefined;
  const sender = failure?.from as Record<string,unknown> | undefined;
  const original = failureMetadata?.xmatrixTurnFailure === true && sender?.instanceId === input.sourceInstanceId
    && typeof failure?.body === "string" && failure !== offered ? failure.body : undefined;
  await dispatchProductAgentSystemNotice({
    env,
    actorUserId: input.actorUserId,
    channelId: input.channelId,
    sourceMessageId: input.sourceMessageId,
    body: [original, input.model
      ? "This model's provider quota is used up. You can retry automatically: the task goes on with another model that has quota, or with this one once it recovers."
      : "No Agent could take over this task. You can wait for its provider quota to recover and retry automatically."]
      .filter(Boolean).join("\n\n"),
    metadata: { kind: AGENT_QUOTA_RETRY_NOTICE_KIND, xmatrixQuotaRetryId: id },
  });
}
/** Readiness is a provider observation newer than the reading that refused
 * (or, for a retry from before that was recorded, than the refusal) that
 * leaves the retry's model headroom on one of its registrations: the account
 * windows and the scoped windows that constrain that model, nothing else. A
 * retry not ready is checked next when what blocks its model stops counting
 * (the last reset of those windows; a windowless hold ends), or with nothing
 * known waits for an event (a reading, a reconnect) rather than a time.
 * `doorbell` is false while a pool's wait would ring for its account although
 * the model stays used up: the reset time wakes the retry instead. */
async function quotaRetryReadiness(
  directory: AuthorityDatabase,
  row: QuotaRetryWork,
): Promise<{ ready: boolean; nextCheckAt: number | null; fence: string; doorbell: boolean }> {
  const keys = row.registrations_json;
  const usages = await readRegistrationQuotaUsages(directory, keys, crypto.randomUUID());
  const now = Date.now();
  const fence = row.refused_through ? new Date(row.refused_through) : new Date(row.created_at);
  const newer = (observedAt: string) => row.refused_through
    ? Date.parse(observedAt) > fence.getTime() : Date.parse(observedAt) >= fence.getTime();
  const candidates = keys.map((key) => {
    const usage = usages.get(registrationQuotaKey(key));
    const quota = retryModelQuota(usage, key.model, now);
    const blocked = quota !== undefined && quota.value <= 0;
    return { ready: quota !== undefined && newer(quota.observedAt) && quota.value > 0,
      nextCheckAt: blocked ? Date.parse(quota.expiresAt) + 1_000 : null,
      accountOpen: blocked && (routingQuotaObservation(usage, now)?.value ?? 100) > 0 };
  });
  const times = candidates.flatMap((candidate) => candidate.nextCheckAt === null ? [] : [candidate.nextCheckAt]);
  return {
    ready: candidates.some((candidate) => candidate.ready),
    nextCheckAt: times.length ? Math.min(Date.parse(String(row.expires_at)), ...times) : null,
    fence: fence.toISOString(),
    doorbell: !candidates.some((candidate) => candidate.accountOpen),
  };
}
/** A continuation stopped by its own model's quota goes on with another
 * model of the same harness that has quota, rather than waiting for that
 * one: the model to resume on ("" the runtime's default) while its own model
 * reads used up; undefined to keep waiting. */
async function continuationModelSwitch(env: Env, channelId: string, row: QuotaRetryWork): Promise<string | undefined> {
  const key = row.registrations_json[0];
  if (row.kind !== "continuation" || !key?.model || !row.source_instance_id) return undefined;
  const facts = await readContinuationModelFacts(env, { commandId: `quota-retry:${row.retry_id}:${row.generation}:model`,
    channelId, sourceInstanceId: row.source_instance_id });
  if (!facts) return undefined;
  const now = Date.now();
  const own = retryModelQuota(facts.observations?.quota?.usage, key.model, now);
  return own && own.value <= 0 ? quotaRecoveryModel(facts, now, key.model) : undefined;
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
      undefined, undefined, refusal?.registrations, refusal?.refusedThrough);
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
      // A redelivered dispatch resumes on the model its first dispatch chose.
      const chosen = row.state !== "dispatching" && !readiness.ready
        ? await continuationModelSwitch(env, channelId, row) : undefined;
      if (!readiness.ready && chosen === undefined) {
        // Not ready at its time: keep its wait (a delivery that found nothing
        // to start may have spent it) and ask for one fresh read of its own
        // pools, newer than what refused it. That reading wakes it. While its
        // model alone stays used up, its reset wakes it instead.
        if ("fence" in readiness && readiness.doorbell) {
          await waitAfterQuotaRefusal(env, { channelId, registrations: row.registrations_json,
            refusedThrough: readiness.fence, verify: true })
            .catch((error: unknown) => console.warn("Quota retry verification failed", {
              error: error instanceof Error ? error.message : String(error) }));
        }
        await repository.settle(channelId, row, "waiting", readiness.nextCheckAt);
        continue;
      }
      const { admission, resumeModel: switchTo } = await repository.dispatch({ channelId, row,
        ...(chosen !== undefined ? { resumeModel: chosen } : {}) });
      if (row.kind === "launch") await retryLaunch(env, channelId, row, admission, database);
      else {
        const body = switchTo === undefined
          ? "Provider quota is available. Resuming the interrupted task from its existing session."
          : `This model's provider quota is used up. Resuming the interrupted task from its existing session on ${
            switchTo || "the runtime's default model"}.`;
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
          ...(switchTo !== undefined ? { preferredRuntimeModel: switchTo } : {}),
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
