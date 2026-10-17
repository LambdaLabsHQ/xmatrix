"use client";

import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import {
  channelPresenceInstances, isChannelResidentInstance, isLiveAgentStatus, WEB_PROXY_ROUTES,
  type ChannelPresence, type OnboardingStage, type SerializedAgentLaunch,
} from "@xmatrix/protocol";
import { recordOnboardingStep } from "@/lib/onboarding-funnel";
import { useOnboardingCopy, useOnboardingLocale } from "@/lib/onboarding-locale";
import { keepCoWriteRequest } from "@/lib/pages/co-write-request";
import { pageApi } from "@/lib/pages/page-client";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { userErrorMessage } from "@/lib/user-facing-error";
import { BringAgentsIn } from "./bring-agents-in";
import { BringWorkIn } from "./bring-work-in";
import { usePageReferenceScope } from "./page-reference-chip";
import { signedOutRegistrations } from "./harness-sign-in";
import { SignedOutAgents } from "./signed-out-agents";
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

/* Until the instance the person's last `@auto` starts is here, there is
   nothing to address and another starter would start a second one, so the
   starters wait. It waits only while that summon is the conversation's last
   word, and what ends it is what the conversation shows anyway: the instance
   arriving, its launch connecting or failing, a refusal, or any later
   message. The name is the harness once routing chose it. */
export function startingStarter(input: {
  presence: ChannelPresence | undefined;
  timeline: ReadonlyArray<{ own?: boolean; isEvent?: boolean; body: string; messageId?: string; sendStatus?: string }>;
  launches: ReadonlyMap<string, readonly SerializedAgentLaunch[]>;
  refused: ReadonlyMap<string, unknown>;
}): { name?: string } | undefined {
  if (starterAddress(input.presence) !== "@auto") return undefined;
  const last = [...input.timeline].reverse().find(item => !item.isEvent);
  if (!last?.own || !last.body.startsWith("@auto ") || last.sendStatus === "failed") return undefined;
  if (!last.messageId) return {};
  if (input.refused.has(last.messageId)) return undefined;
  const launches = input.launches.get(last.messageId) ?? [];
  if (launches.some(launch => launch.state === "connected" || launch.state === "failed" || launch.state === "cancelled")) return undefined;
  const name = launches.find(launch => launch.targetName)?.targetName;
  return name ? { name } : {};
}

export function OnboardingMessage({ stage, spaceId, token, userId, starting, onSendStarter }: {
  stage: OnboardingStage; spaceId: string | null; token: string | null; userId: string;
  /** Set while the instance a starter asked for is still starting (`startingStarter`). */
  starting?: { name?: string };
  /** Sends a starter as the person's own message in this conversation, addressed by `starterAddress`. */
  onSendStarter: (message: string) => void;
}) {
  return stage === "bring-agents"
    ? <BringAgentsMessage spaceId={spaceId} token={token} userId={userId} />
    : <AgentsInMessage spaceId={spaceId} token={token} userId={userId} starting={starting} onSendStarter={onSendStarter} />;
}

/* Once an agent is in and can answer, xMatrix says so in the next message.
   One whose program is signed out answers nothing, so it does not count. The
   Hub checks the fact and writes that message once, so asking again only
   replays it. */
function BringAgentsMessage({ spaceId, token, userId }: { spaceId: string | null; token: string | null; userId: string }) {
  const fleet = useInstalledHarnesses(spaceId, token, userId);
  const enabled = (fleet.catalog.data?.registrations ?? []).filter((registration) => registration.state === "enabled");
  const signedOut = signedOutRegistrations(enabled, userId, fleet.daemons.data);
  const agentsIn = fleet.daemons.isSuccess && enabled.length > signedOut.length;
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

function AgentsInMessage({ spaceId, token, userId, starting, onSendStarter }: {
  spaceId: string | null; token: string | null; userId: string; starting?: { name?: string };
  onSendStarter: (message: string) => void;
}) {
  const pages = usePageReferenceScope();
  const fleet = useInstalledHarnesses(spaceId, token, userId);
  const copy = useOnboardingCopy(spaceId, token, userId);
  const enabled = (fleet.catalog.data?.registrations ?? []).filter((registration) => registration.state === "enabled");
  const signedOut = signedOutRegistrations(enabled, userId, fleet.daemons.data);
  const handles = [...new Set(enabled.filter((registration) => !signedOut.includes(registration))
    .map((registration) => `@${registration.displayName}`))];
  const writer = enabled.find((registration) => !signedOut.includes(registration))?.key.harness;
  const coWrite = useMutation({
    mutationFn: async (harness: string) => {
      const { page } = await pageApi.create(spaceId!, token!, { title: copy.coWrite.pageTitle });
      return { pageId: page.pageId, harness };
    },
    onSuccess: ({ pageId, harness }) => {
      keepCoWriteRequest(pageId, harness);
      pages?.onOpenPage(pageId);
    },
  });
  if (handles.length === 0 && signedOut.length === 0) return null;
  return (
    <div className="app-paper-card max-w-[34rem] text-[15px] leading-6" data-onboarding-stage="agents-in">
      <SignedOutAgents registrations={signedOut} token={token} userId={userId} copy={copy} />
      {handles.length > 0 && <>
      <p className={signedOut.length > 0 ? "mt-3" : undefined}>{copy.agentsIn(copy.listNames(handles), handles.length === 1)}</p>
      <ul className="m-0 mt-2 list-none p-0">
        {writer && spaceId && token && pages && (
          <li className="m-0 p-0">
            <button type="button" disabled={Boolean(starting) || coWrite.isPending} onClick={() => {
              recordOnboardingStep(token, { step: "starter_chosen", surface: "welcome", starter: "cowrite" });
              coWrite.mutate(writer);
            }} className="group/starter -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-foreground/[0.04] disabled:opacity-50">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{copy.coWrite.title}</span>
                <span className="block text-[13px] leading-5 text-muted-foreground">{copy.coWrite.detail(writer)}</span>
              </span>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground group-hover/starter:text-foreground" />
            </button>
          </li>
        )}
        {copy.starters.map((starter) => (
          <li key={starter.id} className="m-0 p-0">
            <button type="button" disabled={Boolean(starting)} onClick={() => {
              recordOnboardingStep(token, { step: "starter_chosen", surface: "welcome", starter: starter.id });
              onSendStarter(starter.message);
            }}
              className="group/starter -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-foreground/[0.04] disabled:opacity-50">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{starter.title}</span>
                <span className="block text-[13px] leading-5 text-muted-foreground">{starter.detail}</span>
              </span>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground group-hover/starter:text-foreground" />
            </button>
          </li>
        ))}
      </ul>
      {coWrite.error && <p role="alert" className="mt-2 text-[13px] leading-5 text-destructive">
        {userErrorMessage(coWrite.error, "Couldn't create the page")}</p>}
      {spaceId && token && <BringWorkIn spaceId={spaceId} token={token} copy={copy} />}
      </>}
      {starting && <p className="mt-2 text-[13px] leading-5 text-muted-foreground" role="status">{copy.starting(starting.name)}</p>}
    </div>
  );
}
