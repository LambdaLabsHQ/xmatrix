"use client";

import { useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  WEB_PROXY_ROUTES, type OnboardingStage, type OnboardingStarter,
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
import { useOnboardingActions } from "./onboarding-actions";
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
  const pages = usePageReferenceScope();
  const fleet = useInstalledHarnesses(spaceId, token, userId);
  const copy = useOnboardingCopy(spaceId, token, userId);
  const enabled = (fleet.catalog.data?.registrations ?? []).filter((registration) => registration.state === "enabled");
  const signedOut = signedOutRegistrations(enabled, userId, fleet.daemons.data);
  const handles = [...new Set(enabled.filter((registration) => !signedOut.includes(registration))
    .map((registration) => `@${registration.displayName}`))];
  const actions = useOnboardingActions();
  const ready = enabled.filter((registration) => !signedOut.includes(registration));
  // Co-writing waits on every line, so it goes to the fastest to answer: Claude
  // and Codex reply in seconds where others take minutes (routing page,
  // measured first replies). The first person who tried it got Grok, and nothing.
  const writer = [...ready].sort((a, b) => writerRank(a.key.harness) - writerRank(b.key.harness))[0]?.key.harness;
  // Two different agents, for the card that has them talk it over.
  const names = [...new Set(ready.map((registration) => registration.displayName))];
  const pair = names.length >= 2 ? [names[0], names[1]] as const : null;
  const count = (starter: OnboardingStarter) => recordOnboardingStep(token, { step: "starter_chosen", surface: "welcome", starter });
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
      <ul className="m-0 mt-3 grid list-none gap-2 p-0 sm:grid-cols-2">
        {actions && <Card title={copy.talk.title} detail={copy.talk.detail}
          onClick={() => { count("talk"); actions.startConversation(""); }} />}
        {actions && <Card title={copy.together.title}
          detail={pair ? copy.together.detail(pair[0], pair[1]) : copy.together.needsTwo}
          disabled={!pair}
          onClick={() => { if (!pair) return; count("together"); actions.startConversation(copy.together.draft(pair[0], pair[1])); }} />}
        {writer && spaceId && token && pages && <Card title={copy.coWrite.title} detail={copy.coWrite.detail(writer)}
          disabled={coWrite.isPending} onClick={() => { count("cowrite"); coWrite.mutate(writer); }} />}
        {actions && <Card title={copy.machines.title} detail={copy.machines.detail}
          onClick={() => { count("machines"); actions.connectAnotherComputer(); }} />}
      </ul>
      {coWrite.error && <p role="alert" className="mt-2 text-[13px] leading-5 text-destructive">
        {userErrorMessage(coWrite.error, "Couldn't create the page")}</p>}
      {spaceId && token && <BringWorkIn spaceId={spaceId} token={token} copy={copy} />}
      </>}
    </div>
  );
}

const FAST_WRITERS = ["claude", "codex"];
function writerRank(harness: string): number {
  const index = FAST_WRITERS.indexOf(harness);
  return index < 0 ? FAST_WRITERS.length : index;
}

/* One thing xMatrix does, on a piece of tinted paper: a title and a line. */
function Card({ title, detail, disabled, onClick }: { title: string; detail: string; disabled?: boolean; onClick: () => void }) {
  return (
    <li className="m-0 p-0">
      <button type="button" disabled={disabled} onClick={onClick}
        className="app-paper-tile flex h-full w-full flex-col items-start gap-1 px-3.5 py-3 text-left disabled:opacity-50">
        <span className="block font-semibold">{title}</span>
        <span className="block text-[13px] leading-5 text-muted-foreground">{detail}</span>
      </button>
    </li>
  );
}
