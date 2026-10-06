import { PostgresAutomationRepository,type DingTalkEffectCoordinator,type DingTalkCoordinationNativeProof,
  type DingTalkInboundEffects,type DingTalkInboundJob } from "@xmatrix/db";
import { postgresMessageAppend } from "../postgres-message-authority";
import type { Env } from "../types";

/** Inactive explicit adapter. There is no path/native issuer, route, queue,
 * default verifier or recovery wake registered in production. */
export function createDingTalkCrossDatabaseEffects(input: { env: Env; coordinator: DingTalkEffectCoordinator;
  verifyNative: DingTalkInboundEffects["verifyNative"];
  nativeProof(job: DingTalkInboundJob,signal: AbortSignal): Promise<DingTalkCoordinationNativeProof>;
}): DingTalkInboundEffects {
  const dispatch=async(job: DingTalkInboundJob,signal: AbortSignal,kind: "channel" | "automation") => {
    for (const destination of await input.coordinator.destinations(job,kind)) {
      const proof=await input.nativeProof(job,signal);
      await input.coordinator.execute({ job,destination,proof,signal,runTarget: async (database,authority,current) => {
        if (kind==='channel') {
          await postgresMessageAppend(input.env,destination.channelId,{ kind: "append-message",commandId: authority.effectId,
            messageId: authority.effectId,principal: { kind: "user",id: destination.authorityRootUserId },appAuthorId: "dingtalk",
            messageKind: "xmatrix.message.text",body: current.candidate.text },
          { database,recoveryDatabase: database,spaceId: job.spaceId,dingtalkEffect: authority });
        } else {
          await new PostgresAutomationRepository(database).fireTrigger({ requestId: crypto.randomUUID(),automationId: destination.id,
            eventId: authority.effectId,event: {},at: new Date().toISOString() },authority);
        }
      } });
    }
  };
  return { verifyNative: input.verifyNative,
    append: ({job},fence)=>dispatch(job,fence.signal,"channel"),
    automations: ({job},fence)=>dispatch(job,fence.signal,"automation") };
}
