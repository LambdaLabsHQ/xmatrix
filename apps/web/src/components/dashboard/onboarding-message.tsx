"use client";

import { useEffect, useRef } from "react";
import {
  WEB_PROXY_ROUTES, type OnboardingStage,
} from "@xmatrix/protocol";
import { useOnboardingCopy, useOnboardingLocale } from "@/lib/onboarding-locale";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { BringAgentsIn } from "./bring-agents-in";
import { BringWorkIn } from "./bring-work-in";
import { signedOutRegistrations } from "./harness-sign-in";
import { SignedOutAgents } from "./signed-out-agents";
import { useInstalledHarnesses } from "./use-installed-harnesses";

/* What xMatrix says to a new person in their welcome conversation. A message
   names only its step; what it shows is read from the facts (the Space's
   agents, the machine's report), so reopening the conversation later shows
   what happened, never a stale command. */

export function OnboardingMessage({ stage, spaceId, token, userId }: {
  stage: OnboardingStage; spaceId: string | null; token: string | null; userId: string;
}) {
  const copy = useOnboardingCopy(spaceId, token, userId);
  // A first message in a new conversation that no agent could answer: xMatrix
  // replies with the same steps that bring one in, under a line saying why.
  if (stage === "connect-agents") return (
    <div data-onboarding-stage="connect-agents">
      <p className="mb-2 text-[15px] leading-6">{copy.unanswered}</p>
      <BringAgentsIn spaceId={spaceId} token={token} userId={userId} surface="conversation" />
    </div>
  );
  return stage === "bring-agents"
    ? <BringAgentsMessage spaceId={spaceId} token={token} userId={userId} />
    : <AgentsInMessage spaceId={spaceId} token={token} userId={userId} />;
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

function AgentsInMessage({ spaceId, token, userId }: {
  spaceId: string | null; token: string | null; userId: string;
}) {
  const fleet = useInstalledHarnesses(spaceId, token, userId);
  const copy = useOnboardingCopy(spaceId, token, userId);
  const enabled = (fleet.catalog.data?.registrations ?? []).filter((registration) => registration.state === "enabled");
  const signedOut = signedOutRegistrations(enabled, userId, fleet.daemons.data);
  const handles = [...new Set(enabled.filter((registration) => !signedOut.includes(registration))
    .map((registration) => `@${registration.displayName}`))];
  if (handles.length === 0 && signedOut.length === 0) return null;
  // One line: the composer below already says "@ to summon an agent".
  return (
    <div className="app-paper-card max-w-[34rem] text-[15px] leading-6" data-onboarding-stage="agents-in">
      <SignedOutAgents registrations={signedOut} token={token} userId={userId} copy={copy} />
      {handles.length > 0 && <>
      <p className={signedOut.length > 0 ? "mt-3" : undefined}>{copy.agentsIn(copy.listNames(handles), handles.length === 1)}</p>
      {spaceId && token && <BringWorkIn spaceId={spaceId} token={token} copy={copy} />}
      </>}
    </div>
  );
}
