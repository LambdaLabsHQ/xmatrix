"use client";

import { useState, type ReactNode } from "react";
import type { HarnessSignedOut } from "@xmatrix/protocol";
import { useOnboardingCopy } from "@/lib/onboarding-locale";
import { HarnessSignedOutBody, type HarnessSignInTarget } from "./harness-sign-in";
import { useInstalledHarnesses } from "./use-installed-harnesses";

/* A notice whose program needs signing in on its machine: a summon refused
   for it, a turn it refused (its sign-in expired), or an Agent's request for
   it. The machine's owner signs it in here and a refused summon is sent
   again; anyone else reads the notice as written (HARNESS_SIGNED_OUT_NOTICE_KIND).
   Signing in belongs to the machine, so its owner needs no Agent for the
   program in this Space. */
export function HarnessSignedOutNotice({ signedOut, requestedBy, spaceId, token, userId, onSignedIn, notice }: {
  signedOut: HarnessSignedOut; spaceId: string | null; token: string | null; userId: string;
  /** The Agent that asked for this sign-in, when one did. */
  requestedBy?: string;
  /** Sends the refused summon again; false when this viewer cannot. Absent for a failed turn. */
  onSignedIn?: () => Promise<boolean>;
  /** The notice as written, for a viewer who cannot sign this program in. */
  notice: ReactNode;
}) {
  const fleet = useInstalledHarnesses(spaceId, token, userId);
  const copy = useOnboardingCopy(spaceId, token, userId);
  const [resent, setResent] = useState<"sent" | "failed" | "again" | "told" | null>(null);
  const target: HarnessSignInTarget | undefined = fleet.catalog.data?.registrations.find((candidate) =>
    candidate.key.ownerUserId === userId && candidate.key.machineId === signedOut.machineId &&
    candidate.key.harness === signedOut.harness) ?? ownedMachineTarget(fleet.daemons.data, userId, signedOut);
  if (!target || !token) return <>{notice}</>;
  return (
    <div className="app-paper-card max-w-[34rem] text-[15px] leading-6" data-testid="harness-signed-out-notice">
      {requestedBy && notice}
      <HarnessSignedOutBody registration={target} token={token} userId={userId} copy={copy}
        program={signedOut.program} machine={signedOut.machineName ?? target.machineName}
        onSignedIn={() => {
          // A refused summon is sent again; a failed turn is the person's to ask again.
          if (requestedBy) { setResent("told"); return; }
          if (!onSignedIn) { setResent("again"); return; }
          void onSignedIn().then((sent) => setResent(sent ? "sent" : "again"), () => setResent("failed"));
        }} />
      {resent && <p role="status" className="mt-2 text-[13px] leading-5 text-muted-foreground">
        {resent === "told" ? copy.tellAgent(requestedBy!) : resent === "sent" ? copy.signedInResent
          : resent === "again" ? copy.sendAgain : copy.resendFailed}</p>}
    </div>
  );
}

/** The viewer's own machine the program is on, when they have no Agent for it here. */
function ownedMachineTarget(daemons: readonly { userId: string; machineId?: string; machineName?: string; name: string }[] | undefined,
  userId: string, signedOut: HarnessSignedOut): HarnessSignInTarget | undefined {
  const daemon = daemons?.find((item) => item.userId === userId && item.machineId === signedOut.machineId);
  return daemon ? { key: { ownerUserId: userId, machineId: signedOut.machineId, harness: signedOut.harness },
    machineName: signedOut.machineName ?? daemon.machineName ?? daemon.name } : undefined;
}
