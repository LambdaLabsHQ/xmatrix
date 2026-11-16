import type { DingTalkEffectCoordinator,DingTalkCoordinationNativeProof,
  DingTalkInboundEffects,DingTalkInboundJob } from "@xmatrix/db";
import { postgresMessageAppend } from "../postgres-message-authority";
import type { Env } from "../types";

/** Inactive explicit adapter. There is no path/native issuer, route, queue,
 * default verifier or recovery wake registered in production. */
export function createDingTalkCrossDatabaseEffects(input: { env: Env; coordinator: DingTalkEffectCoordinator;
  verifyNative: DingTalkInboundEffects["verifyNative"];
  nativeProof(job: DingTalkInboundJob,signal: AbortSignal): Promise<DingTalkCoordinationNativeProof>;
}): DingTalkInboundEffects {
  return { verifyNative: input.verifyNative,
    async append({ job },fence) {
      for (const destination of await input.coordinator.destinations(job)) {
        const proof=await input.nativeProof(job,fence.signal);
        await input.coordinator.execute({ job,destination,proof,signal: fence.signal,runTarget: async (database,authority,current) => {
          await postgresMessageAppend(input.env,destination.channelId,{ kind: "append-message",commandId: authority.effectId,
            messageId: authority.effectId,principal: { kind: "user",id: destination.authorityRootUserId },appAuthorId: "dingtalk",
            messageKind: "xmatrix.message.text",body: current.candidate.text },
          { database,recoveryDatabase: database,spaceId: job.spaceId,dingtalkEffect: authority });
        } });
      }
    } };
}
