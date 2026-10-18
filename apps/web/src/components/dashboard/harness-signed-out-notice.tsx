"use client";

import { useState, type ReactNode } from "react";
import type { HarnessSignedOut } from "@xmatrix/protocol";
import { useOnboardingCopy } from "@/lib/onboarding-locale";
import { HarnessSignInSection } from "./harness-sign-in";
import { useInstalledHarnesses } from "./use-installed-harnesses";

/* A notice whose program is signed out on its machine: a summon refused for
   it, or a turn it refused (its sign-in expired). The machine's owner signs
   it in here and a refused summon is sent again; anyone else reads the notice
   as written (HARNESS_SIGNED_OUT_NOTICE_KIND). */
export function HarnessSignedOutNotice({ signedOut, spaceId, token, userId, onSignedIn, notice }: {
  signedOut: HarnessSignedOut; spaceId: string | null; token: string | null; userId: string;
  /** Sends the refused summon again; false when this viewer cannot. Absent for a failed turn. */
  onSignedIn?: () => Promise<boolean>;
  /** The notice as written, for a viewer who cannot sign this program in. */
  notice: ReactNode;
}) {
  const fleet = useInstalledHarnesses(spaceId, token, userId);
  const copy = useOnboardingCopy(spaceId, token, userId);
  const [resent, setResent] = useState<"sent" | "failed" | "again" | null>(null);
  const registration = fleet.catalog.data?.registrations.find((candidate) => candidate.key.ownerUserId === userId &&
    candidate.key.machineId === signedOut.machineId && candidate.key.harness === signedOut.harness);
  if (!registration || !token) return <>{notice}</>;
  return (
    <div className="app-paper-card max-w-[34rem] text-[15px] leading-6" data-testid="harness-signed-out-notice">
      <p>{copy.signedOut(signedOut.program, signedOut.machineName ?? registration.machineName)}</p>
      <div className="mt-2">
        <HarnessSignInSection registration={registration} token={token} userId={userId} bare signInLabel={copy.signIn}
          onSignedIn={() => {
            // A refused summon is sent again; a failed turn is the person's to ask again.
            if (!onSignedIn) { setResent("again"); return; }
            void onSignedIn().then((sent) => setResent(sent ? "sent" : "again"), () => setResent("failed"));
          }} />
      </div>
      {resent && <p role="status" className="mt-2 text-[13px] leading-5 text-muted-foreground">
        {resent === "sent" ? copy.signedInResent : resent === "again" ? copy.sendAgain : copy.resendFailed}</p>}
    </div>
  );
}
