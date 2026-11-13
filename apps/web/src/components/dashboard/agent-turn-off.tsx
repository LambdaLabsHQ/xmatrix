"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { appViewAddress, type AgentRegistrationSummary } from "@xmatrix/protocol";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import { Button } from "@/components/ui/button";
import type { OnboardingCopy } from "@/lib/onboarding-copy";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { machineSwitch } from "./my-agents-registrations";
import { registrationTupleId, useRegistrationCommand } from "./use-registration-command";

/* The owner's other answer to a program that cannot take work on its machine:
   turn its Agent off there. That is the machine's own switch, in every Space
   (registrationEnvironmentCommand), the one Agents turns on again, so "send it
   no work" is a setting its owner made and can read, never something xMatrix
   inferred about the program's sign-in. */

/** What a card reads and does about that switch. `agent` is the viewer's own
 * Agent for the program in this Space; without one there is nothing to turn off. */
export function useAgentTurnOff(agent: AgentRegistrationSummary | undefined, token: string, userId: string) {
  const queryClient = useQueryClient();
  const spaceId = agent?.key.spaceId ?? "";
  const command = useRegistrationCommand(spaceId, token, () => void queryClient.invalidateQueries({
    queryKey: xmatrixQueryKeys.domain({ userId }, "agent-registration-catalog", [spaceId]) }));
  // Shown off at once; the Agent list says so itself once it is read again.
  const [turnedOff, setTurnedOff] = useState(false);
  const read = machineSwitch(agent, userId);
  return {
    off: read.off || turnedOff,
    offered: read.canTurnOff && !turnedOff,
    pending: command.pendingId !== null,
    error: command.notice?.error ? command.notice.text : null,
    turnOff: async () => {
      if (agent && await command.run(agent.key, { kind: "disable" })) setTurnedOff(true);
    },
  };
}

/** The quiet choice beside the sign-in, where it is offered. */
export function AgentTurnOffButton({ turn, copy }: { turn: ReturnType<typeof useAgentTurnOff>; copy: OnboardingCopy }) {
  return (
    <Button size="sm" variant="ghost" disabled={turn.pending} data-testid="turn-agent-off" onClick={() => void turn.turnOff()}>
      {turn.pending ? <AnimatedIcon icon={Loader2} className="animate-spin" /> : null}{copy.turnOff}
    </Button>
  );
}

/** Off, and where its owner turns it on again. */
export function AgentTurnedOff({ agent, copy, program, machine }: {
  agent: AgentRegistrationSummary; copy: OnboardingCopy; program: string; machine: string;
}) {
  return (
    <p role="status" data-testid="agent-turned-off">
      {copy.turnedOff(program, machine)}{copy.gap}{copy.turnOnAgain[0]}
      <a href={appViewAddress(agent.key.spaceId, "agents", registrationTupleId(agent.key))}
        className="font-semibold text-foreground underline-offset-2 hover:underline">{copy.turnOnAgain[1]}</a>
      {copy.turnOnAgain[2]}
    </p>
  );
}
