"use client";

import { actionClass } from "@/components/ui/action-tone";
import { useState } from "react";
import { ArrowUp, Check, FolderPlus, Loader2, Sparkles } from "lucide-react";
import { suggestedSpaceFolderName } from "./space-first-task";
import { SetupCardHeader, SetupCardShell } from "./space-setup-card-chrome";
import type { ChosenWorkspace } from "./space-first-task-choose-workspace";
import type { SpaceFirstTaskState } from "./space-first-task";

/* The step after an agent is bound: give it somewhere to work, then send it
   something. The channel is a side effect of the message, not a prerequisite the
   human has to understand first — the one line about what a channel is sits
   here, where it is about to become true, and is confirmed a moment later by
   watching the agent answer in it. */

/* A fresh folder has no project to read, so the example message produces something
   instead: a file the human can open. It names the canonical runbook on
   purpose — an agent asked to explain xMatrix from memory invents an answer. */
const DEFAULT_FIRST_MESSAGE =
  "Read https://xmatrix.sh/start.md and write a notes.md in this folder with three sentences on how I should hand you work through xMatrix.";

export function SpaceFirstTaskCard({
  state,
  spaceName,
  workspace,
  busy,
  error,
  onChooseWorkspace,
  onLaunch,
}: {
  state: SpaceFirstTaskState;
  spaceName: string | undefined;
  /* Chosen in this session. Deliberately not persisted: a Space does not own a
     directory until the association layer exists, and the card says so rather
     than implying a binding it cannot keep. */
  workspace: ChosenWorkspace | null;
  busy: boolean;
  error: string | null;
  onChooseWorkspace: () => void;
  onLaunch: (message: string) => void;
}) {
  const [message, setMessage] = useState(DEFAULT_FIRST_MESSAGE);

  if (state.kind === "hidden") return null;

  return (
    <SetupCardShell>
      <SetupCardHeader
        icon={Sparkles}
        title="Send the first message"
        body="It answers in a new conversation — the room you and an agent share, where whoever you @ gets to work."
      />

      <div className="mt-4 rounded-md border border-border bg-background p-4">
        <p className="text-sm font-bold">
          {workspace ? "Working folder" : "First, pick a folder for the Agent"}
        </p>
        {workspace ? (
          <p className="mt-1 min-w-0 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {workspace.canonicalCwd}
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            The agent runs inside a folder you choose. A new, empty one is a good start — the picker
            can create{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">
              ~/xmatrix/{suggestedSpaceFolderName(spaceName)}
            </code>
            .
          </p>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={onChooseWorkspace}
          className={actionClass({ variant: "secondary", size: "md" }, "mt-3")}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <FolderPlus className="size-4" />}
          {workspace ? "Choose a different folder" : "Choose or create a folder"}
        </button>
        <p className="mt-3 text-xs text-muted-foreground">
          This choice applies to this Agent launch. It does not bind the folder to this space.
        </p>
      </div>

      <textarea
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        rows={3}
        placeholder="Write a message"
        className="mt-4 w-full resize-y rounded-md border border-border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-ring"
      />

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          disabled={busy || !workspace}
          onClick={() => onLaunch(message)}
          className={actionClass({ variant: "primary", size: "md" }, "shrink-0")}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : workspace ? <ArrowUp className="size-4" strokeWidth={2.5} /> : <Check className="size-4" />}
          Start
        </button>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        This starts a conversation with your message, addressed @auto. It names itself from what you asked; you can
        rename it from its header at any time.
      </p>

      {error && (
        <p className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </SetupCardShell>
  );
}
