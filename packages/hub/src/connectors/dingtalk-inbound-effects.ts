import { PostgresAutomationRepository, type AuthorityDatabase, type DingTalkAppIdentity,
  type DingTalkInboundEffects, type PostgresDingTalkInboundInboxRepository } from "@xmatrix/db";
import { postgresMessageAppend } from "../postgres-message-authority";
import type { Env } from "../types";

/**
 * Explicit same-physical-database dispatcher. No route, cron, Stream or queue
 * registers it. A real native verifier is a required dependency; no default
 * interpretation of unknown company modes or conversation proof exists.
 */
export function createDingTalkPrimaryInboundEffects(input: {
  env: Env; app: DingTalkAppIdentity; repository: PostgresDingTalkInboundInboxRepository;
  database: AuthorityDatabase; verifyNative: DingTalkInboundEffects["verifyNative"];
}): DingTalkInboundEffects {
  return {
    verifyNative: input.verifyNative,
    async append({ job,event },fence) {
      const request=() => ({ app: input.app,job,requestId: crypto.randomUUID() });
      const destinations=await input.repository.effectDestinations({ ...request(),kind: "channel" });
      for (const destination of destinations) {
        if (fence.signal.aborted || !await fence.current() || fence.signal.aborted) throw new Error("DingTalk effect expired");
        const authority=await input.repository.effectAuthority({ ...request(),destination,signal: fence.signal });
        await postgresMessageAppend(input.env,destination.channelId,{
          kind: "append-message",commandId: authority.effectId,messageId: authority.effectId,
          principal: { kind: "user",id: destination.authorityRootUserId },appAuthorId: "dingtalk",
          messageKind: "xmatrix.message.text",body: event.body,
        },{ database: input.database,recoveryDatabase: input.database,spaceId: job.spaceId,dingtalkEffect: authority });
      }
    },
    async automations({ job },fence) {
      const request=() => ({ app: input.app,job,requestId: crypto.randomUUID() });
      const destinations=await input.repository.effectDestinations({ ...request(),kind: "automation" });
      const repository=new PostgresAutomationRepository(input.database);
      for (const destination of destinations) {
        if (fence.signal.aborted || !await fence.current() || fence.signal.aborted) throw new Error("DingTalk effect expired");
        const authority=await input.repository.effectAuthority({ ...request(),destination,signal: fence.signal });
        await repository.fireTrigger({ requestId: crypto.randomUUID(),automationId: destination.id,
          eventId: authority.effectId,event: {},at: new Date().toISOString() },authority);
      }
    },
  };
}
