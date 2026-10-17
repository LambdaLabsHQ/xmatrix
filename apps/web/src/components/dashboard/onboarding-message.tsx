"use client";

import { useEffect, useRef } from "react";
import { ChevronRight } from "lucide-react";
import {
  channelPresenceInstances, isChannelResidentInstance, isLiveAgentStatus, WEB_PROXY_ROUTES,
  type ChannelPresence, type OnboardingStage, type OnboardingStarter,
} from "@xmatrix/protocol";
import { recordOnboardingStep } from "@/lib/onboarding-funnel";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { BringAgentsIn } from "./bring-agents-in";
import { listNames } from "./connect-machine";
import { useInstalledHarnesses } from "./use-installed-harnesses";

/* What xMatrix says to a new person in their welcome conversation. A message
   names only its step; what it shows is read from the facts (the Space's
   agents, the machine's report), so reopening the conversation later shows
   what happened, never a stale command. */

/* The first task should end in a page, which is where xMatrix makes sense;
   each starter asks for one. Sent as the person's own message, addressed to
   the agent already in this conversation, else to Auto, which picks one of
   their agents. */
const FIRST_TASK_STARTERS = [
  { id: "project", title: "Write a page about my project", detail: "What it is, where it stands and what is still open.",
    message: "Write a page about a project I'm working on: what it is, where it stands and what is still open. Ask me which project first." },
  { id: "plan", title: "Plan something with me", detail: "The plan stays in a page as we go.",
    message: "Help me plan something I'm working on, and keep the plan in a page as we go." },
  /* It names the canonical runbook on purpose: an agent asked to explain
     xMatrix from memory invents an answer. */
  { id: "xmatrix", title: "Show me how to hand you work", detail: "Reads xmatrix.sh/start.md and writes it up as a page.",
    message: "Read https://xmatrix.sh/start.md and write a page on how I should hand you work through xMatrix." },
] as const satisfies ReadonlyArray<{ id: OnboardingStarter; title: string; detail: string; message: string }>;

/* `@auto` and `@<harness>` always start a new instance: that is how work is
   split between agents in parallel. Someone trying the starters one after
   another means the conversation they already have, so a starter goes to the
   instance already here: working, idle or asleep, the most recently seen
   first. One whose wake failed, or whose machine is offline, would not act on
   it, so Auto starts another. */
function starterAddress(presence: ChannelPresence | undefined): string {
  const here = channelPresenceInstances(presence).filter(instance => instance.channelInstanceId &&
    isChannelResidentInstance(instance) && instance.rest !== "wake_failed" && !instance.offlineReason);
  const rank = (instance: (typeof here)[number]) => [isLiveAgentStatus(instance.status) ? 1 : 0, Date.parse(instance.lastSeenAt) || 0];
  const [instance] = here.sort((left, right) => {
    const [leftLive, leftSeen] = rank(left), [rightLive, rightSeen] = rank(right);
    return rightLive - leftLive || rightSeen - leftSeen;
  });
  return instance ? `@${instance.agentName}:${instance.channelInstanceId}` : "@auto";
}

export function OnboardingMessage({ stage, spaceId, token, userId, presence, onSend }: {
  stage: OnboardingStage; spaceId: string | null; token: string | null; userId: string;
  /** Who is in this conversation, so a starter goes to the agent already here. */
  presence: ChannelPresence | undefined;
  /** Sends a starter as the person's own message in this conversation. */
  onSend: (body: string) => void;
}) {
  return stage === "bring-agents"
    ? <BringAgentsMessage spaceId={spaceId} token={token} userId={userId} />
    : <AgentsInMessage spaceId={spaceId} token={token} userId={userId} presence={presence} onSend={onSend} />;
}

/* Once an agent is in, xMatrix says so in the next message. The Hub checks
   the fact and writes that message once, so asking again only replays it. */
function BringAgentsMessage({ spaceId, token, userId }: { spaceId: string | null; token: string | null; userId: string }) {
  const fleet = useInstalledHarnesses(spaceId, token, userId);
  const agentsIn = (fleet.catalog.data?.registrations ?? []).some((registration) => registration.state === "enabled");
  const asked = useRef(false);
  useEffect(() => {
    if (!agentsIn || asked.current || !spaceId || !token) return;
    asked.current = true;
    void xmatrixApiRequest({ url: WEB_PROXY_ROUTES.space_welcome(spaceId), token, method: "POST" })
      .catch((error: unknown) => console.warn("[xmatrix] welcome step unavailable", error));
  }, [agentsIn, spaceId, token]);
  return <BringAgentsIn spaceId={spaceId} token={token} userId={userId} surface="welcome" />;
}

function AgentsInMessage({ spaceId, token, userId, presence, onSend }: {
  spaceId: string | null; token: string | null; userId: string; presence: ChannelPresence | undefined;
  onSend: (body: string) => void;
}) {
  const fleet = useInstalledHarnesses(spaceId, token, userId);
  const handles = [...new Set((fleet.catalog.data?.registrations ?? [])
    .filter((registration) => registration.state === "enabled")
    .map((registration) => `@${registration.displayName}`))];
  if (handles.length === 0) return null;
  return (
    <div className="max-w-[34rem] text-[15px] leading-6" data-onboarding-stage="agents-in">
      <p>
        {listNames(handles)} {handles.length === 1 ? "is" : "are"} in. Mention {handles.length === 1 ? "it" : "one"} here
        to give {handles.length === 1 ? "it" : "them"} work, or start with one of these:
      </p>
      <ul className="m-0 mt-3 list-none border-t-[1px] border-border p-0">
        {FIRST_TASK_STARTERS.map((starter) => (
          <li key={starter.id} className="m-0 border-b-[1px] border-border p-0">
            <button type="button" onClick={() => {
              recordOnboardingStep(token, { step: "starter_chosen", surface: "welcome", starter: starter.id });
              onSend(`${starterAddress(presence)} ${starter.message}`);
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
