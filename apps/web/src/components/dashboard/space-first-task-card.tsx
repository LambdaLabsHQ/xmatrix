"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import { actionClass } from "@/components/ui/action-tone";
import { useState } from "react";
import { ArrowUp, FolderPlus, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { SetupCardShell } from "./space-setup-card-chrome";
import type { ChosenWorkspace } from "./space-first-task-choose-workspace";
import type { SpaceFirstTaskState } from "./space-first-task";

/* The step after an agent is in, on every device. It says the third sentence
   xMatrix teaches where it is about to become true: the first task ends in a
   Page, because seeing a conclusion written into a page is the moment the
   product makes sense. Each starter asks for one; the person may write their
   own instead. The conversation is a side effect of the message, not a
   prerequisite to understand first. */

type Starter = { id: string; label: string; message: (inFolder: boolean) => string };

export const FIRST_TASK_STARTERS: Starter[] = [
  {
    id: "project",
    label: "My project",
    message: (inFolder) => inFolder
      ? "Read the project in this folder and write its page: what it is, where it stands and what is still open."
      : "Write a page about a project I'm working on: what it is, where it stands and what is still open. Ask me which project first.",
  },
  {
    id: "plan",
    label: "A plan",
    message: () => "Help me plan something I'm working on, and keep the plan in a page as we go.",
  },
  {
    /* It names the canonical runbook on purpose: an agent asked to explain
       xMatrix from memory invents an answer. */
    id: "xmatrix",
    label: "Learn xMatrix",
    message: () => "Read https://xmatrix.sh/start.md and write a page on how I should hand you work through xMatrix.",
  },
];

export function SpaceFirstTaskCard({
  state,
  folderPicker,
  workspace,
  busy,
  error,
  onChooseWorkspace,
  onLaunch,
}: {
  state: SpaceFirstTaskState;
  /** The desktop app can point the agent at a folder; elsewhere it works in its own. */
  folderPicker: boolean;
  /* Chosen in this session. Deliberately not persisted: a Space does not own a
     directory until the association layer exists. */
  workspace: ChosenWorkspace | null;
  busy: boolean;
  error: string | null;
  onChooseWorkspace: () => void;
  onLaunch: (message: string) => void;
}) {
  const [starterId, setStarterId] = useState<string | null>(FIRST_TASK_STARTERS[0]!.id);
  const [draft, setDraft] = useState<string | null>(null);
  const starter = FIRST_TASK_STARTERS.find((candidate) => candidate.id === starterId);
  // A starter's words follow the folder until the person writes their own.
  const message = draft ?? starter?.message(Boolean(workspace)) ?? "";

  if (state.kind === "hidden") return null;

  return (
    <SetupCardShell>
      <div data-testid="first-task">
        <h2 className="text-lg font-black leading-tight">Just talk. Agents keep the facts in Pages</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Ask for something. Your agent answers in a new conversation and writes what matters into a page.
        </p>

        <div role="radiogroup" aria-label="Start from" className="mt-5 flex flex-wrap gap-2">
          {FIRST_TASK_STARTERS.map((candidate) => (
            <button key={candidate.id} type="button" role="radio" aria-checked={candidate.id === starterId}
              onClick={() => { setStarterId(candidate.id); setDraft(null); }}
              className={cn("h-7 rounded-[999px] border-[1px] px-3 text-xs font-semibold",
                candidate.id === starterId
                  ? "border-foreground bg-muted text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground")}>
              {candidate.label}
            </button>
          ))}
        </div>

        <textarea
          aria-label="First message"
          value={message}
          onChange={(event) => { setDraft(event.target.value); setStarterId(null); }}
          rows={4}
          placeholder="Ask your agent for something"
          className="mt-3 w-full resize-y rounded-[10px] border-[1px] border-border bg-background p-3 text-sm outline-none focus:border-foreground"
        />

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          {folderPicker ? (
            <button type="button" disabled={busy} onClick={onChooseWorkspace}
              className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
              <FolderPlus className="size-4 shrink-0" />
              <span className="min-w-0 truncate">
                {workspace ? <span className="font-mono">{workspace.canonicalCwd}</span> : "Work in a folder of yours (optional)"}
              </span>
            </button>
          ) : <span />}
          <button type="button" disabled={busy || !message.trim()} onClick={() => onLaunch(message)}
            className={actionClass({ variant: "primary", size: "md" }, "shrink-0")}>
            {busy ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : <ArrowUp className="size-4" strokeWidth={2.5} />}
            Start
          </button>
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          The first reply takes about a minute while the agent starts. The conversation names itself from what you asked.
        </p>

        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      </div>
    </SetupCardShell>
  );
}
