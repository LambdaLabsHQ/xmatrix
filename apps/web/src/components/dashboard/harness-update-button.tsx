"use client";

import { useState } from "react";
import type { HarnessTooOld } from "@xmatrix/protocol";
import { Loader2 } from "lucide-react";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { actionClass } from "@/components/ui/action-tone";
import { UserFacingProblem, userErrorMessage } from "@/lib/user-facing-error";
import { queueHarnessAction, readHarnessAction } from "./machine-harness-api";
import type { useInstalledHarnesses } from "./use-installed-harnesses";

const POLL_MS = 2_000;
/** An update the daemon has not settled in this long is reported, not waited on. */
const GIVE_UP_MS = 5 * 60_000;

/* Updates a harness its machine reports too old for xMatrix, with the
   machine's own update recipe (the owner's click is the approval), then has
   the caller read the machine again so the new version is what it shows. */
export function HarnessUpdateButton({ token, machineId, hostId, presetId, program, onUpdated }: {
  token: string | null | undefined; machineId: string; hostId?: string; presetId: string;
  /** What is updated, as its vendor names it (`Cursor CLI`). */
  program: string;
  onUpdated: () => void;
}) {
  const [state, setState] = useState<"idle" | "running" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!token) return;
    setState("running");
    setError(null);
    try {
      const { controlId } = await queueHarnessAction(token, machineId, hostId, presetId, "update");
      const startedAt = Date.now();
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const status = await readHarnessAction(token, controlId);
        if (status.status === "queued" || status.status === "running") {
          if (Date.now() - startedAt > GIVE_UP_MS) throw new UserFacingProblem(`${program} is still updating on that machine.`);
          continue;
        }
        if (status.status !== "succeeded") throw new UserFacingProblem(status.error || `${program} could not be updated there.`);
        break;
      }
      setState("idle");
      onUpdated();
    } catch (reason) {
      setState("failed");
      setError(userErrorMessage(reason, "Couldn't send that to the machine"));
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" disabled={!token || state === "running"} onClick={() => void run()}
        className={actionClass({ variant: "secondary", size: "sm" })}>
        {state === "running" ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : null}
        {state === "running" ? "Updating…" : `Update ${program}`}
      </button>
      {error && <span role="alert" className="text-[13px] leading-5 text-destructive">{error}</span>}
    </span>
  );
}

type Fleet = ReturnType<typeof useInstalledHarnesses>;

/** The update for one installed candidate its machine reports too old, then a fresh read of the machine. */
export function CandidateUpdateButton({ fleet, candidate, tooOld }: {
  fleet: Fleet; candidate: Fleet["candidates"][number]; tooOld: HarnessTooOld;
}) {
  return <HarnessUpdateButton token={fleet.token} machineId={candidate.key.machineId} hostId={candidate.daemon.hostId}
    presetId={candidate.preset.id} program={tooOld.program} onUpdated={() => void fleet.daemons.refetch()} />;
}
