/* The screen right after an agent is bound to a Space. Without it the shell
   falls back to the timeline's "No conversations yet" empty state, which can
   only point at New conversation in the sidebar.

   The first channel is therefore not something to explain up front — it is
   created by sending the first task, and the concept lands because the human
   watches it happen. The channel is `main` so naming is not a first-run
   decision; it can be renamed from the channel header like any other.

   What this screen must NOT do is answer the directory question on the human's
   behalf. Registered directories are keyed by (owner, machine) with no Space
   dimension, so listing them here shows one organisation's repositories while
   the human works in another organisation's Space — and picking one publishes
   its absolute path into that Space's channel. A Space starts with nothing and
   is given a directory explicitly. */

import { formatAutoLaunchMention } from "@xmatrix/protocol";

/* Path segments xMatrix creates for itself. Registration is a side effect of
   running `xmatrix` in a directory, so managed worktrees and per-run scratch
   directories can be registered exactly like a human's project. Matching whole
   segments keeps a real project named `xmatrix` (this repository, for one)
   out of the exclusion. */
const XMATRIX_MANAGED_SEGMENTS = new Set([
  ".xmatrix",
  ".xmatrix-management",
  ".xmatrix-management-quarantine",
]);

export function isXmatrixManagedWorkspacePath(path: string): boolean {
  const segments = path.split(/[\\/]/u).filter(Boolean);
  if (segments.some((segment) => XMATRIX_MANAGED_SEGMENTS.has(segment))) return true;
  /* Legacy pools use <hash>/slots/<id>; compact pools use <8 hex>/<6 hex>. */
  return segments.some((segment, index) => segment === "repo-pools" && (
    segments[index + 2] === "slots"
    || (/^[a-f0-9]{8}$/u.test(segments[index + 1] ?? "")
      && /^[a-f0-9]{6}$/u.test(segments[index + 2] ?? ""))
  ));
}

export type SpaceFirstTaskAgent = {
  id: string;
  name: string;
  spaceId?: string;
};

export type SpaceFirstTaskState =
  | { kind: "hidden" }
  /* Bound agent, no conversation yet: the first task starts the first one. */
  | { kind: "first-task"; agent: SpaceFirstTaskAgent };

/* Every device gets the first task. Without a folder the agent works in the
   folder xMatrix keeps for it on its machine, so the browser and the phone,
   which have no folder picker, need no directory to start. */
export function spaceFirstTaskState(input: {
  channelsLoaded: boolean;
  agentsLoaded: boolean;
  spaceAgents: SpaceFirstTaskAgent[];
  spaceChannelCount: number;
  spaceId: string | null | undefined;
}): SpaceFirstTaskState {
  if (!input.channelsLoaded || !input.agentsLoaded) return { kind: "hidden" };
  if (!input.spaceId) return { kind: "hidden" };
  /* One channel is enough to stop guiding: from then on the shell's own empty
     states are about a conversation, not about having none. */
  if (input.spaceChannelCount > 0) return { kind: "hidden" };

  const agent = input.spaceAgents.find(
    (candidate) =>
      !candidate.spaceId || candidate.spaceId === input.spaceId
  );
  if (!agent) return { kind: "hidden" };
  return { kind: "first-task", agent };
}

export type FirstTaskComposition =
  | { ok: true; body: string }
  | { ok: false; reason: string };

/* A chosen folder constrains the Auto mention; without one the agent works in
   its xMatrix-kept folder. All subsequent text remains ordinary message
   content and follows the shared mention grammar. */
export function composeFirstTaskMessage(input: {
  workspacePath?: string | null;
  message: string;
}): FirstTaskComposition {
  const workspacePath = input.workspacePath?.trim();
  const message = input.message.trim();
  if (!message) return { ok: false, reason: "Write what you want done" };
  if (!workspacePath) return { ok: true, body: `${formatAutoLaunchMention({})} ${message}` };
  if (isXmatrixManagedWorkspacePath(workspacePath)) {
    return {
      ok: false,
      reason: "That folder belongs to xMatrix itself. Choose or create a folder of your own.",
    };
  }

  return { ok: true, body: `${formatAutoLaunchMention({ pwd: workspacePath })} ${message}` };
}
