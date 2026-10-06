"use client";

import { Pin, SlashSquare, Wrench } from "lucide-react";
import {
  CompletionOptionButton,
  avatarInitials,
  stopTouchPropagation,
} from "@/components/dashboard/completion-option-button";
import { IdentityAvatar } from "@/components/dashboard/identity-avatar";
import type {
  SlashCommandCandidate,
  SlashCommandTarget,
  SlashCompletionStage,
} from "@/components/dashboard/slash-complete";

function commandIcon(action: SlashCommandCandidate["action"]) {
  if (action?.startsWith("agent-goal-")) return <Pin className="size-4" />;
  if (action === "agent-model-switch" || action === "agent-effort-switch") {
    return <Wrench className="size-4" />;
  }
  return <SlashSquare className="size-4" />;
}

function targetCountLabel(count: number): string {
  return count === 1 ? "1 instance" : `${count} instances`;
}

/**
 * The slash-first palette: commands the channel's live instances accept, then
 * which instance runs the one that was picked. Both stages render the same row
 * shape as the mention panel so the two feel like one surface.
 */
export function SlashCommandPanel({
  stage,
  stageLabel,
  commands,
  targets,
  activeIndex,
  optionRef,
  listRef,
  onSelectCommand,
  onSelectTarget,
}: {
  stage: SlashCompletionStage;
  stageLabel: string;
  commands: SlashCommandCandidate[];
  targets: SlashCommandTarget[];
  activeIndex: number;
  optionRef: (index: number) => (node: HTMLElement | null) => void;
  listRef: (node: HTMLDivElement | null) => void;
  onSelectCommand: (command: SlashCommandCandidate) => void;
  onSelectTarget: (target: SlashCommandTarget) => void;
}) {
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={stageLabel}
      className="app-mention-suggestions w-full overflow-y-auto border-b border-border/60"
      onTouchStart={stopTouchPropagation}
      onTouchMove={stopTouchPropagation}
    >
      <div className="border-b border-border/60 px-2 py-1.5 text-xs font-bold text-foreground/75">
        {stageLabel}
      </div>
      {stage === "command"
        ? commands.map((command, index) => (
            <CompletionOptionButton
              key={command.id}
              optionRef={optionRef(index)}
              selected={index === activeIndex}
              onSelect={() => onSelectCommand(command)}
              className="min-h-10 border-b border-border/30 last:border-b-0"
            >
              <span className="flex size-7 shrink-0 items-center justify-center text-foreground/45 [&_svg]:size-[18px] [&_svg]:stroke-[1.75]">
                {commandIcon(command.action)}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <span className="block truncate font-semibold">
                  {command.token}
                  <span className="ml-1.5 font-normal text-foreground/55">{command.label}</span>
                </span>
                <span className="block truncate text-xs text-foreground/55">
                  {command.description || `Run ${command.token} on a live instance`}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {command.targets.some((target) => target.local) && (
                  <span className="rounded bg-primary/10 px-1.5 py-0 text-[10px] font-bold text-primary">
                    this machine
                  </span>
                )}
                <span className="rounded bg-muted/70 px-1.5 py-0 text-[10px] text-muted-foreground">
                  {targetCountLabel(command.targets.length)}
                </span>
              </span>
            </CompletionOptionButton>
          ))
        : targets.map((target, index) => (
            <CompletionOptionButton
              key={target.instanceId}
              optionRef={optionRef(index)}
              selected={index === activeIndex}
              onSelect={() => onSelectTarget(target)}
              className="min-h-10 border-b border-border/30 last:border-b-0"
            >
              <IdentityAvatar
                kind="agent"
                label={target.label}
                initials={avatarInitials(target.label)}
                imageUrl={target.avatarUrl}
                size="sm"
                shape="circle"
              />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-semibold">{target.label}</span>
                <span className="ml-1.5 text-foreground/50">@{target.mention}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {target.local && (
                  <span className="rounded bg-primary/10 px-1.5 py-0 text-[10px] font-bold text-primary">
                    this machine
                  </span>
                )}
                <span className="rounded bg-muted/70 px-1.5 py-0 text-[10px] text-muted-foreground">
                  {target.status}
                </span>
              </span>
            </CompletionOptionButton>
          ))}
    </div>
  );
}
