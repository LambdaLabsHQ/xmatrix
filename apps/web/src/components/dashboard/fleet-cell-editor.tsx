"use client";

import { ChevronRight, X } from "lucide-react";
import { AGENT_PRESETS, type HarnessAction } from "@xmatrix/protocol";

import { actionClass } from "@/components/ui/action-tone";
import { cn } from "@/lib/utils";

import type { AgentListGroup } from "./agent-list-groups";
import { agentBalanceReadings, agentUsageReadings } from "./agent-quota-usage";
import { Face } from "./face";
import { MachineHarnessPanel } from "./machine-harness-panel";
import { MeterReadingList } from "./machine-load-panel";
import { formatRelativeAge } from "./time-display";
import { ToolStateDot } from "./tool-split";
import type { MachineSummary } from "./workspace-shell-helpers";

/** Instances listed before the rest are counted: a cell's editor is a slip, not the agent's page. */
const INSTANCES_SHOWN = 4;

/** What a cell says while something is being done to its agent on the machine. */
export function cellOperationLabel(action: HarnessAction): string {
  return action === "install" ? "Installing…" : action === "update" ? "Updating…" : action === "uninstall" ? "Removing…" : "Saving…";
}

/**
 * One cell of the matrix, edited where it is: an agent on a machine. On the
 * reader's own machine that is the agent's line as its machine's page has it:
 * install, the switch for this Space, sign in, version and updates. For an
 * agent of the Space it adds where it works and what it has used. What is
 * set on the agent, and the machine itself, are one click further.
 */
export function FleetCellEditor({
  harness, machineName, machine, own, row, token, spaceId, now, working, conversationTitle,
  onOperation, onOpenAgent, onOpenMachine, onOpenConversation, onClose,
}: {
  harness: string;
  machineName: string;
  /** The machine, where the reader's list carries it. */
  machine: MachineSummary | undefined;
  /** The reader's own machine: its programs are theirs to install, sign in and turn on. */
  own: boolean;
  /** The agent of this Space in the cell, if the Space has one there. */
  row: AgentListGroup["rows"][number] | undefined;
  token: string | undefined;
  spaceId: string | null;
  now: number;
  /** The Instances with work in hand. */
  working: ReadonlySet<string>;
  conversationTitle: (channelId: string) => string | undefined;
  onOperation: (action: HarnessAction | null) => void;
  onOpenAgent: () => void;
  onOpenMachine: () => void;
  onOpenConversation: (channelId: string) => void;
  onClose: () => void;
}) {
  const program = AGENT_PRESETS.find((preset) => preset.id === harness)?.displayName ?? harness;
  const live = row?.registration.live;
  const running = live?.running ?? [];
  const usage = row ? [...agentUsageReadings(live?.quota, now), ...agentBalanceReadings(live?.balance)] : [];
  const mine = !row || own;
  return (
    <div className="space-y-3" data-testid="fleet-cell-edit">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {program} on {machineName}{row && !mine ? ` · ${row.registration.ownerName}` : ""}
        </p>
        <button type="button" onClick={onClose} aria-label="Close" title="Close (Esc)"
          className={actionClass({ variant: "quiet", size: "icon-sm" })}><X className="size-4" aria-hidden="true" /></button>
      </div>

      {own && machine?.daemon ? (
        // The usage is read in full below, so the line does not draw it a second time.
        <MachineHarnessPanel key={`${spaceId}:${machine.id}:${harness}`} daemon={machine.daemon} token={token} spaceId={spaceId ?? undefined}
          only={harness} onOperation={onOperation}
          agentOn={() => row && { state: row.activity.state, line: row.activity.brief, usage: [] }} />
      ) : row && (
        <div className="flex min-w-0 items-center gap-3 text-sm">
          <Face of={{ kind: "agent", name: harness, harness }} size="sm" showKindBadge={false} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{row.machineInLine ? row.title : program}</p>
            <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
              <ToolStateDot state={row.activity.state} />{row.activity.brief}</p>
          </div>
        </div>
      )}

      {running.length > 0 && (
        <ul className="app-tool-lines text-sm" aria-label="In conversations">
          {running.slice(0, INSTANCES_SHOWN).map((instance) => {
            const title = conversationTitle(instance.channelId);
            const atWork = working.has(instance.instanceId);
            return (
              <li key={instance.instanceId} className="flex min-w-0 items-baseline gap-2 py-1">
                {title ? (
                  <button type="button" onClick={() => onOpenConversation(instance.channelId)}
                    className="min-w-0 truncate text-left font-semibold hover:underline">#{title}</button>
                ) : <span className="min-w-0 truncate font-semibold">A conversation</span>}
                <span className={cn("ml-auto shrink-0 text-xs", atWork ? "font-semibold text-foreground" : "text-muted-foreground")}>
                  {atWork ? "Working" : "Waiting"}{formatRelativeAge(instance.since, now) ? ` · ${formatRelativeAge(instance.since, now)}` : ""}
                </span>
              </li>
            );
          })}
          {running.length > INSTANCES_SHOWN && (
            <li className="py-1 text-xs text-muted-foreground">and {running.length - INSTANCES_SHOWN} more</li>
          )}
        </ul>
      )}

      {usage.length > 0 && <MeterReadingList label={`${program} usage`} readings={usage} />}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-foreground/10 pt-2 text-xs">
        {row && (
          <button type="button" onClick={onOpenAgent} data-testid="fleet-cell-open-agent"
            className="flex items-center gap-0.5 font-semibold text-muted-foreground hover:text-foreground">
            Settings, access and details <ChevronRight className="size-3.5" aria-hidden="true" /></button>
        )}
        {machine && (
          <button type="button" onClick={onOpenMachine} data-testid="fleet-cell-open-machine"
            className="flex items-center gap-0.5 font-semibold text-muted-foreground hover:text-foreground">
            {machineName} <ChevronRight className="size-3.5" aria-hidden="true" /></button>
        )}
      </div>
    </div>
  );
}
