"use client";

import { useState } from "react";
import type { InteractionLaunchOption } from "@xmatrix/protocol";
import { useOnboardingCopy } from "@/lib/onboarding-locale";
import { userErrorMessage } from "@/lib/user-facing-error";
import { OptionMark } from "./first-message-launch-choice";
import { BringAgentsIn } from "./bring-agents-in";

/** Positive server evidence, followed by an explicit author choice. Mounting
 * this line or connecting a computer never sends work. */
export function MessageAskLine({ options, catalogReady, hasRegistrations, spaceId, token, userId, onAsk }: {
  options: readonly InteractionLaunchOption[]; catalogReady: boolean; hasRegistrations: boolean;
  spaceId: string; token: string | null; userId: string; onAsk: (harness: string) => Promise<void>;
}) {
  const copy = useOnboardingCopy(spaceId, token, userId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = async (harness: string) => {
    setPending(true); setError(null);
    try { await onAsk(harness); }
    catch (failure) { setPending(false); setError(userErrorMessage(failure, "Couldn't start the Agent")); }
  };
  return <div className="launch-choice" role="group" aria-label={copy.askAgent}>
    <div className="launch-choice-row">
      <span className="launch-choice-label">{copy.nobodyAsked}</span>
      {options.length > 0 && <div className="launch-choice-options">
        {options.map(option => <button key={option.optionId} type="button" className="launch-choice-option"
          disabled={pending} onClick={() => void choose(option.harness)} aria-label={`${copy.askAgent}: ${option.displayName}`}>
          <OptionMark option={option} /><span>{option.displayName}</span>
        </button>)}
      </div>}
    </div>
    {catalogReady && !options.length && (hasRegistrations
      ? <p className="text-sm text-muted-foreground">{copy.noAvailableAgent}</p>
      : <BringAgentsIn spaceId={spaceId} token={token} userId={userId} surface="conversation" />)}
    {error && <p role="alert" className="launch-choice-error">{error}</p>}
  </div>;
}
