"use client";

import { useCallback, useRef, useState } from "react";
import type { InteractionLaunchOption } from "@xmatrix/protocol";
import { useOnboardingCopy } from "@/lib/onboarding-locale";
import { userErrorMessage } from "@/lib/user-facing-error";
import { LaunchAgentMenu } from "./launch-agent-menu";
import { BringAgentsIn } from "./bring-agents-in";

/** Positive server evidence, followed by an explicit author choice. Mounting
 * this line or connecting a computer never sends work. It is the launch
 * line's sentence and menu: one line of text, and the Agents behind one word. */
export function MessageAskLine({ options, catalogReady, hasRegistrations, spaceId, token, userId, onAsk }: {
  options: readonly InteractionLaunchOption[]; catalogReady: boolean; hasRegistrations: boolean;
  spaceId: string; token: string | null; userId: string; onAsk: (harness: string) => Promise<void>;
}) {
  const copy = useOnboardingCopy(spaceId, token, userId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const line = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(false), []);
  const choose = async (harness: string) => {
    setPending(true); setError(null);
    try { await onAsk(harness); }
    catch (failure) { setPending(false); setError(userErrorMessage(failure, "Couldn't start the Agent")); }
  };
  return <div ref={line} className="launch-line" data-state="ask" role="group" aria-label={copy.askAgent}>
    <span className="launch-line-status">{copy.nobodyAsked}</span>
    {options.length > 0 && (
      <button type="button" className="launch-line-action" aria-haspopup="menu" aria-expanded={menu}
        disabled={pending} onClick={() => setMenu(true)}>{copy.askAgent}</button>
    )}
    {catalogReady && !options.length && (hasRegistrations
      ? <span className="launch-line-note">{copy.noAvailableAgent}</span>
      : <BringAgentsIn spaceId={spaceId} token={token} userId={userId} surface="conversation" />)}
    {error && <span role="alert" className="launch-line-error">{error}</span>}
    {menu && line.current && (
      <LaunchAgentMenu anchor={line.current} label={copy.askAgent} options={options}
        onPick={option => void choose(option.harness)} onClose={closeMenu} />
    )}
  </div>;
}
