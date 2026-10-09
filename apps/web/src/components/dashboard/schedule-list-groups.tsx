"use client";

import { useMemo } from "react";
import type { SerializedAutomation, SerializedChannel } from "@xmatrix/protocol";

import { usePageTree } from "@/components/pages/pages-view";
import { formatAutomationCadence, formatAutomationNext } from "@/components/pages/page-automation-format";

import { channelTitle } from "./channel-links";
import { groupSchedules, scheduleAttention, scheduleRunning, type ScheduleState } from "./schedules-model";
import { ToolListGroup, ToolListRow } from "./tool-split";

export const SCHEDULE_GROUP_TITLES: Record<ScheduleState, string> = {
  attention: "Needs attention",
  running: "Running",
  paused: "Paused",
};

export function nextRunPhrase(nextRunAt: string, now: number): string {
  void now; // formatAutomationNext reads the clock; `now` only re-renders it.
  return formatAutomationNext(nextRunAt).replace(/^next (?:run )?/u, "") || "unscheduled";
}

/** Where an Automation lives: the page it keeps a section of, or the conversation it posts to. */
export function useScheduleWhere(spaceId: string | null, token: string, channels: readonly SerializedChannel[]) {
  const pageTree = usePageTree(spaceId, token);
  const pageTitles = useMemo(() => new Map((pageTree.data ?? []).map((page) => [page.pageId, page.title])),
    [pageTree.data]);
  return (automation: SerializedAutomation) => {
    if (automation.pageId) return pageTitles.get(automation.pageId) ?? "Untitled page";
    const channel = channels.find((item) => item.id === automation.channelId);
    return `#${channel ? channelTitle(channel) : automation.channelId}`;
  };
}

/** Schedules as Status lists them: grouped by what each one is doing, so a row needs no mark. */
export function ScheduleListGroups({ automations, executionEnabled, where, now, selectedId, onSelect,
  titles = SCHEDULE_GROUP_TITLES, limit }: {
  automations: SerializedAutomation[];
  executionEnabled: boolean | null;
  where: (automation: SerializedAutomation) => string;
  now: number;
  selectedId: string | null;
  onSelect: (automationId: string) => void;
  titles?: Record<ScheduleState, string>;
  /** Rows each group shows before the rest are asked for. */
  limit?: number;
}) {
  const groups = useMemo(() => groupSchedules(automations, executionEnabled), [automations, executionEnabled]);
  const whenOf = (automation: SerializedAutomation) => automation.detachedAt ? "detached"
    : scheduleRunning(automation) ? nextRunPhrase(automation.nextRunAt, now) : "paused";
  return groups.map((group) => (
    <ToolListGroup key={group.state} title={titles[group.state]} count={group.automations.length}
      limit={limit}>
      {group.automations.map((automation) => (
        <ToolListRow key={automation.id} testId="schedule-row" state={group.state}
          selected={automation.id === selectedId}
          onSelect={() => onSelect(automation.id)}
          title={automation.name}
          end={group.state === "paused" ? undefined : whenOf(automation)}
          subtitle={group.state === "attention" ? scheduleAttention(automation, executionEnabled)
            : `${where(automation)} · ${formatAutomationCadence(automation.intervalMinutes)}`} />
      ))}
    </ToolListGroup>
  ));
}
