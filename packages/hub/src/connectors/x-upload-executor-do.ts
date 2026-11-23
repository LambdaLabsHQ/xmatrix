import { DurableObject } from "cloudflare:workers";
import type { XUploadReference } from "@xmatrix/db";
import type { Env } from "../types";
import { connectorActionRequestRepository } from "./credentials";
import { executeDurableXUpload, publishDurableXUploadReceipt } from "./connector-commands";
import { XUploadExecutor } from "./x-upload-executor";
import { runAsDeliveryInvocation } from "../runtime-transport/runtime-principal-delivery";
import { nornActionExecutor } from "../norn-actions";
import { settleNornAppRequest } from "../norn-programs";

export class RelayXUploadExecutor extends DurableObject<Env> {
  private readonly executor: XUploadExecutor;
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    const repository = connectorActionRequestRepository(env);
    this.executor = new XUploadExecutor(state.storage, {
      executingUpload: ref => repository.executingUpload(ref),
      settleUpload: input => repository.settleUpload(input),
      uploadOutcome: ref => repository.uploadOutcome(ref),
      clearUploadOutcome: ref => repository.clearUploadOutcome(ref),
      // A Norn program's action runs with its own provider's executor; an X video action with X's.
      execute: job => executeDurableXUpload(env, job, job.request.nornPerformRef
        ? nornActionExecutor(job.request.providerId, job.request.actionId) : undefined),
      publish: async outcome => {
        // The program has its answer first; the receipt in the conversation follows, and a repeat of either changes nothing.
        if (outcome.request.nornPerformRef) await settleNornAppRequest(env, { channelId: outcome.request.channelId,
          requestRef: outcome.request.nornPerformRef, outcome: outcome.status === "completed"
            ? { done: outcome.result ?? { summary: outcome.receipt } }
            : outcome.status === "blocked" ? { blocked: outcome.receipt } : { failed: outcome.receipt } });
        await publishDurableXUploadReceipt(env, outcome);
      },
    });
  }
  // Each call and alarm is one delivery invocation: the receipts it publishes share one budget.
  async enqueue(ref: XUploadReference): Promise<void> { await runAsDeliveryInvocation(() => this.executor.enqueue(ref)); }
  async alarm(): Promise<void> { await runAsDeliveryInvocation(() => this.executor.alarm()); }
}

/** Await this durable handoff before acknowledging an admitted video upload. */
export async function enqueueXUpload(env: Pick<Env, "RELAY_X_UPLOAD_EXECUTOR">, ref: XUploadReference): Promise<void> {
  const namespace = env.RELAY_X_UPLOAD_EXECUTOR;
  if (!namespace) throw new Error("X video upload execution is unavailable");
  const stub = namespace.get(namespace.idFromName(JSON.stringify([ref.spaceId, ref.requestId])));
  await stub.enqueue(ref);
}
