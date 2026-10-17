"use client";

import { useEffect, useRef } from "react";
import { ChevronRight } from "lucide-react";
import {
  channelPresenceInstances, isChannelResidentInstance, isLiveAgentStatus, WEB_PROXY_ROUTES,
  type ChannelPresence, type OnboardingStage,
} from "@xmatrix/protocol";
import { recordOnboardingStep } from "@/lib/onboarding-funnel";
import { useOnboardingCopy, useOnboardingLocale } from "@/lib/onboarding-locale";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { BringAgentsIn } from "./bring-agents-in";
import { useInstalledHarnesses } from "./use-installed-harnesses";

/* What xMatrix says to a new person in their welcome conversation. A message
   names only its step; what it shows is read from the facts (the Space's
   agents, the machine's report), so reopening the conversation later shows
   what happened, never a stale command. */

/* `@auto` and `@<harness>` always start a new instance: that is how work is
   split between agents in parallel. Someone trying the starters one after
   another means the conversation they already have, so a starter goes to the
   instance already here: working, idle or asleep, the most recently seen
   first. One whose wake failed, or whose machine is offline, would not act on
   it, so Auto starts another. */
export function starterAddress(presence: ChannelPresence | undefined): string {
  const here = channelPresenceInstances(presence).filter(instance => instance.channelInstanceId &&
    isChannelResidentInstance(instance) && instance.rest !== "wake_failed" && !instance.offlineReason);
  const rank = (instance: (typeof here)[number]) => [isLiveAgentStatus(instance.status) ? 1 : 0, Date.parse(instance.lastSeenAt) || 0];
  const [instance] = here.sort((left, right) => {
    const [leftLive, leftSeen] = rank(left), [rightLive, rightSeen] = rank(right);
    return rightLive - leftLive || rightSeen - leftSeen;
  });
  return instance ? `@${instance.agentName}:${instance.channelInstanceId}` : "@auto";
}

export function OnboardingMessage({ stage, spaceId, token, userId, onSendStarter }: {
  stage: OnboardingStage; spaceId: string | null; token: string | null; userId: string;
  /** Sends a starter as the person's own message in this conversation, addressed by `starterAddress`. */
  onSendStarter: (message: string) => void;
}) {
  return stage === "bring-agents"
    ? <BringAgentsMessage spaceId={spaceId} token={token} userId={userId} />
    : <AgentsInMessage spaceId={spaceId} token={token} userId={userId} onSendStarter={onSendStarter} />;
}

/* Once an agent is in, xMatrix says so in the next message. The Hub checks
   the fact and writes that message once, so asking again only replays it. */
function BringAgentsMessage({ spaceId, token, userId }: { spaceId: string | null; token: string | null; userId: string }) {
  const fleet = useInstalledHarnesses(spaceId, token, userId);
  const agentsIn = (fleet.catalog.data?.registrations ?? []).some((registration) => registration.state === "enabled");
  const locale = useOnboardingLocale(spaceId, token, userId);
  const asked = useRef(false);
  useEffect(() => {
    if (!agentsIn || asked.current || !spaceId || !token) return;
    asked.current = true;
    void xmatrixApiRequest({ url: WEB_PROXY_ROUTES.space_welcome(spaceId), token, method: "POST", body: { locale } })
      .catch((error: unknown) => console.warn("[xmatrix] welcome step unavailable", error));
  }, [agentsIn, spaceId, token, locale]);
  return <BringAgentsIn spaceId={spaceId} token={token} userId={userId} surface="welcome" />;
}

function AgentsInMessage({ spaceId, token, userId, onSendStarter }: {
  spaceId: string | null; token: string | null; userId: string; onSendStarter: (message: string) => void;
}) {
  const fleet = useInstalledHarnesses(spaceId, token, userId);
  const copy = useOnboardingCopy(spaceId, token, userId);
  const handles = [...new Set((fleet.catalog.data?.registrations ?? [])
    .filter((registration) => registration.state === "enabled")
    .map((registration) => `@${registration.displayName}`))];
  if (handles.length === 0) return null;
  return (
    <div className="max-w-[34rem] text-[15px] leading-6" data-onboarding-stage="agents-in">
      <p>{copy.agentsIn(copy.listNames(handles), handles.length === 1)}</p>
      <ul className="m-0 mt-3 list-none border-t-[1px] border-border p-0">
        {copy.starters.map((starter) => (
          <li key={starter.id} className="m-0 border-b-[1px] border-border p-0">
            <button type="button" onClick={() => {
              recordOnboardingStep(token, { step: "starter_chosen", surface: "welcome", starter: starter.id });
              onSendStarter(starter.message);
            }}
              className="group/starter flex w-full items-center gap-3 py-3 text-left">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{starter.title}</span>
                <span className="block text-[13px] leading-5 text-muted-foreground">{starter.detail}</span>
              </span>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground group-hover/starter:text-foreground" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
