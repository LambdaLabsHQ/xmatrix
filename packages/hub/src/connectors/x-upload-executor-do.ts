import { DurableObject } from "cloudflare:workers";
import type { XUploadReference } from "@xmatrix/db";
import type { Env } from "../types";
import { connectorActionRequestRepository } from "./credentials";
import { executeDurableXUpload, publishDurableXUploadReceipt } from "./connector-commands";
import { XUploadExecutor } from "./x-upload-executor";
import { runAsDeliveryInvocation } from "../runtime-transport/runtime-principal-delivery";

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
      execute: job => executeDurableXUpload(env, job),
      publish: outcome => publishDurableXUploadReceipt(env, outcome),
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
