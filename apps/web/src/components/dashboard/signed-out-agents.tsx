"use client";

import { agentPresetById, type AgentRegistrationSummary } from "@xmatrix/protocol";
import type { OnboardingCopy } from "@/lib/onboarding-copy";
import { HarnessSignedOutBody } from "./harness-sign-in";

/* An agent brought in whose own program is signed out on its machine looks
   ready and answers nothing. Onboarding names the program and the machine and
   offers the sign-in in the same place (signedOutRegistrations). */
export function SignedOutAgents({ registrations, token, userId, copy }: {
  registrations: readonly AgentRegistrationSummary[]; token: string | null | undefined; userId: string | undefined;
  copy: OnboardingCopy;
}) {
  if (!token || !userId || registrations.length === 0) return null;
  return registrations.map((registration) => (
    <div key={JSON.stringify(registration.key)} className="mt-3" data-testid="signed-out-agent">
      <HarnessSignedOutBody registration={registration} token={token} userId={userId} copy={copy}
        program={agentPresetById(registration.key.harness)?.displayName ?? registration.displayName}
        machine={registration.machineName} />
    </div>
  ));
}
