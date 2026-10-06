import type { DingTalkAppIdentity } from "./dingtalk-suite-control.js";
import type { DingTalkInboundJob } from "./dingtalk-inbound-values.js";
import type { PostgresDingTalkInboundInboxRepository } from "./dingtalk-inbound-inbox.js";

export interface DingTalkInboundEvent {
  eventId: string;
  sourceRef: string;
  feature: "message.received";
  summary: string;
  body: string;
}

type Current = NonNullable<Awaited<ReturnType<PostgresDingTalkInboundInboxRepository["current"]>>>;
type Repository = Pick<PostgresDingTalkInboundInboxRepository,"claim" | "current" | "finish">;
/** Must be enforced by the owning effect boundary, not just by an ingress preflight. */
export interface DingTalkInboundEffectFence { current(): Promise<boolean>; signal: AbortSignal }
export interface DingTalkInboundEffects {
  verifyNative(current: Current,signal: AbortSignal): Promise<void>;
  append(input: { job: DingTalkInboundJob; event: DingTalkInboundEvent },fence: DingTalkInboundEffectFence): Promise<void>;
  automations(input: { job: DingTalkInboundJob; event: DingTalkInboundEvent },fence: DingTalkInboundEffectFence): Promise<void>;
}

/**
 * Dormant transport-neutral drain. There is no production dispatcher, cron,
 * queue wake, default verifier or public caller. A future adapter must supply
 * scoped capabilities which enforce the fence at their actual effect owner.
 * @dormant
 */
export async function drainDingTalkInbound(input: { app: DingTalkAppIdentity; repository: Repository;
  effects: DingTalkInboundEffects; signal?: AbortSignal; deadlineMs?: number }) {
  const deadlineMs = input.deadlineMs ?? 20000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs<1 || deadlineMs>20000) throw new Error("Invalid DingTalk drain deadline");
  const request = () => ({ app: input.app,requestId: crypto.randomUUID() });
  if (input.signal?.aborted) return;
  const jobs = await input.repository.claim(request());
  if (jobs.length>8) throw new Error("DingTalk drain exceeds its claim bound");
  await Promise.all(jobs.map(async job => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort",abort,{ once: true });
    if (input.signal?.aborted) abort();
    let outcome: "done" | "obsolete" | "retry" = "retry";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    const expired = new Promise<never>((_,reject) => {
      cancel = () => reject(new Error("DingTalk drain expired"));
      controller.signal.addEventListener("abort",cancel,{ once: true });
      timer = setTimeout(abort,deadlineMs);
      if (controller.signal.aborted) cancel();
    });
    const current = async () => {
      if (controller.signal.aborted) return false;
      const value = await input.repository.current({ ...request(),job });
      return !controller.signal.aborted && !!value;
    };
    const fence = { current,signal: controller.signal };
    try {
      outcome = await Promise.race([expired,(async (): Promise<"done" | "obsolete" | "retry"> => {
        if (controller.signal.aborted) throw new Error("DingTalk drain expired");
        const captured = await input.repository.current({ ...request(),job });
        if (!captured || controller.signal.aborted) return "obsolete";
        await input.effects.verifyNative(captured,controller.signal);
        if (!await current()) return "obsolete";
        const event: DingTalkInboundEvent = { eventId: captured.eventId,sourceRef: captured.sourceRef,
          feature: "message.received",summary: "DingTalk text message",body: captured.candidate.text };
        // Stable IDs survive a crash between effects. Only an owning-boundary capability may dispatch them.
        await input.effects.append({ job,event },fence);
        if (!await current()) return "obsolete";
        await input.effects.automations({ job,event },fence);
        return await current() ? "done" : "obsolete";
      })()]);
    } catch { /* Private payload/provider errors never enter logs or a completed receipt. */ }
    finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort",cancel);
      controller.abort();
      input.signal?.removeEventListener("abort",abort);
    }
    await input.repository.finish({ ...request(),job,outcome });
  }));
}
