import type {
  DesktopAgentPresetDiscovery,
  DesktopDaemonStatus,
} from "@/lib/desktop/bridge";

/* First-run guidance for a Space that has no agent yet.
   A Space's agents are its registrations, so this is not only the "just
   registered" screen: every new Space starts here and has to add a local agent.
   The state below is derived, never stored — the same inputs the Local view
   already reads (daemon status + preset discovery) decide what to show, so a
   Space that gets its first agent silently stops showing the card.

   What this deliberately does NOT decide: whether the runtime is signed in.
   Claude's subscription credentials live in the macOS Keychain, so probing
   config files would report "not authenticated" for authenticated machines.
   A false negative there is worse than saying nothing, so the card only
   states verifiable facts (the binary runs; these directories were used
   before) and lets the first real task prove the rest. */

export type SpaceAgentSetupInput = {
  channelsLoaded: boolean;
  /* Whether the registration read for this Space has actually come back. An
     empty list is the state before the first read as much as it is the state
     of a Space with no agent, so the count alone cannot tell the two apart —
     and this card asserts the second one. */
  agentsLoaded: boolean;
  /* The read failed. Distinct from "has not answered yet": an unfinished read
     is a state to stay quiet about, a failed one is a problem to report. */
  spaceAgentsUnreachable: boolean;
  spaceAgentCount: number;
  desktopAvailable: boolean;
  discoveryAvailable: boolean;
  loadingDiscoveries: boolean;
  daemonStatus?: DesktopDaemonStatus | null;
  discoveries: DesktopAgentPresetDiscovery[];
};

export type SpaceAgentSetupCandidate = {
  presetId: string;
  displayName: string;
  runtime: string;
  /* The runtime has been used on this machine before (its config directory
     exists), which is what makes its recent directories trustworthy. */
  usedBefore: boolean;
  /* Only a count. The directories themselves are this machine's runtime
     history, which spans every organisation this person works for, so they are
     never surfaced inside a Space — the working folder is chosen explicitly. */
  knownWorkspaceCount: number;
};

export type SpaceAgentSetupState =
  /* An agent already exists in this Space, whether the Space has one is not
     known yet, or there is nothing to guide. */
  | { kind: "hidden" }
  /* The registration read failed. Nothing about agents can be said, but the reason
     can be — silence here reads as "your Space is empty". */
  | { kind: "unreachable" }
  /* Web or mobile: this machine cannot be inspected from here. The only
     honest next step is the remote-machine path. */
  | { kind: "no-local-machine" }
  | { kind: "discovering" }
  /* Nothing runnable found locally: install a runtime, or point at another
     machine. */
  | { kind: "no-runtime" }
  /* Runtimes found, but the daemon that would launch them is not up. */
  | { kind: "daemon-stopped"; candidates: SpaceAgentSetupCandidate[] }
  | { kind: "ready-to-bind"; candidates: SpaceAgentSetupCandidate[] };

export function spaceAgentSetupCandidates(
  discoveries: DesktopAgentPresetDiscovery[]
): SpaceAgentSetupCandidate[] {
  return discoveries
    .filter((discovery) => discovery.runtimeAvailable)
    .map((discovery) => ({
      presetId: discovery.presetId,
      displayName: discovery.displayName,
      runtime: discovery.runtime,
      usedBefore: discovery.configDirs.length > 0,
      knownWorkspaceCount: discovery.workspaces.length,
    }))
    /* Rank by how much context we can offer: a runtime with known recent
       directories can launch a real task in one click, one without them
       still needs the human to pick a directory. */
    .sort((left, right) => {
      if (left.knownWorkspaceCount !== right.knownWorkspaceCount) {
        return right.knownWorkspaceCount - left.knownWorkspaceCount;
      }
      if (left.usedBefore !== right.usedBefore) return left.usedBefore ? -1 : 1;
      return left.displayName.localeCompare(right.displayName);
    });
}

export function spaceAgentSetupState(
  input: SpaceAgentSetupInput
): SpaceAgentSetupState {
  if (!input.channelsLoaded) return { kind: "hidden" };
  /* Every panel below tells the human this Space has no agent yet and asks
     them to produce one. None of them may run on a guess.

     A failed read gets its own screen. Showing nothing would be honest about
     agents and silent about the reason, and a human looking at an empty area
     concludes the Space is empty — the very reading this whole state machine
     exists to prevent. */
  if (input.spaceAgentsUnreachable) return { kind: "unreachable" };
  if (!input.agentsLoaded) return { kind: "hidden" };
  if (input.spaceAgentCount > 0) return { kind: "hidden" };
  if (!input.desktopAvailable || !input.discoveryAvailable) {
    return { kind: "no-local-machine" };
  }

  const candidates = spaceAgentSetupCandidates(input.discoveries);
  /* Keep showing the last discovery result while a refresh runs; only an
     empty first pass may render the spinner. */
  if (input.loadingDiscoveries && candidates.length === 0) {
    return { kind: "discovering" };
  }
  if (candidates.length === 0) return { kind: "no-runtime" };
  if (input.daemonStatus?.state !== "running") {
    return { kind: "daemon-stopped", candidates };
  }
  return { kind: "ready-to-bind", candidates };
}
