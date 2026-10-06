"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  AUTOMATION_MAX_INTERVAL_MINUTES,
  AUTOMATION_MIN_INTERVAL_MINUTES,
  isAutomationIntervalMinutes,
  pageBlocks,
  type AutomationUpdateRequest,
  type SerializedAutomation,
  type SerializedChannel,
  type SerializedSpace,
} from "@xmatrix/protocol";
import { AlertTriangle, ChevronRight, Clock, FileText, Loader2, MessageSquare, Pause, Pencil, Play,
  Trash2 } from "lucide-react";
import { pageDocumentQuery, usePageTree } from "@/components/pages/pages-view";
import { formatAutomationCadence, formatAutomationNext, formatAutomationTrigger } from "@/components/pages/page-automation-format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { noticeClass } from "@/components/ui/status-tone";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth-context";
import { channelTitle } from "./channel-links";
import { ListSkeleton } from "./content-skeleton";
import {
  groupSchedules, scheduleAttention, scheduleRunning, scheduleState, scheduleSummary, sectionFallbackTitle,
  type ScheduleState,
} from "./schedules-model";
import { spaceMemberCanCreate } from "./space-member-permissions";
import { formatRelativeAge } from "./time-display";
import {
  ToolDetail, ToolDetailEmpty, ToolDetailSection, ToolFact, ToolFacts, ToolList, ToolListGroup, ToolListRow, ToolSplit,
  ToolStateDot, useToolItem,
} from "./tool-split";
import { AutomationExpressionGuidance, automationExpressionFromText } from "./workspace-admin-views";
import { evaluationBindingLabel, formatDateTime } from "./workspace-shell-recovered";

const GROUP_TITLES: Record<ScheduleState, string> = {
  attention: "Needs attention",
  running: "Running",
  paused: "Paused",
};

/**
 * The Space's Schedules: every Automation it runs, listed page by page, and
 * the one chosen from the list with what can be done about it — pause,
 * resume, change, delete, answer a pause request. Nothing is made here. An
 * Automation is made on a page, in the section it keeps true
 * (docs/design/pages-live-document.md §6); this is the Space-wide index of
 * those records. With nothing chosen, the paper is the overview: what needs
 * attention and what runs next.
 */
export function SchedulesView({
  spaceId,
  token,
  automations,
  executionEnabled,
  spaces,
  currentUserId,
  channels,
  busy,
  error,
  loadError,
  loadingAutomations,
  focusAutomationId,
  onFocusConsumed,
  onUpdateAutomation,
  onToggleAutomation,
  onDeleteAutomation,
  onOpenPage,
  onOpenConversation,
  onOpenPages,
}: {
  spaceId: string | null;
  token: string;
  automations: SerializedAutomation[];
  executionEnabled: boolean | null;
  spaces: SerializedSpace[];
  currentUserId: string;
  channels: SerializedChannel[];
  busy: string | null;
  error: string | null;
  loadError: string | null;
  loadingAutomations: boolean;
  /** An Automation to open with its editor, e.g. from a conversation's details. */
  focusAutomationId?: string;
  onFocusConsumed?: () => void;
  onUpdateAutomation: (automationId: string, input: Omit<AutomationUpdateRequest, "expectedVersion">) => void;
  onToggleAutomation: (automation: SerializedAutomation) => void;
  onDeleteAutomation: (automation: SerializedAutomation) => void;
  onOpenPage: (pageId: string) => void;
  onOpenConversation: (channelId: string) => void;
  onOpenPages: () => void;
}) {
  const { user } = useAuth();
  const [selectedId, select] = useToolItem();
  const [editingId, setEditingId] = useState<string | null>(null);
  // Relative times ("next in 8 min") stay true while the view is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const summary = useMemo(() => scheduleSummary(automations, executionEnabled), [automations, executionEnabled]);
  const selected = automations.find((automation) => automation.id === selectedId);

  const pageTree = usePageTree(spaceId, token);
  const pageTitles = useMemo(() => new Map((pageTree.data ?? []).map((page) => [page.pageId, page.title])),
    [pageTree.data]);
  // Section titles come from the pages the listed Automations are on: one read per such page.
  const pageIds = useMemo(() => [...new Set(automations.flatMap((automation) => automation.pageId ? [automation.pageId] : []))],
    [automations]);
  const documents = useQueries({
    queries: pageIds.map((pageId) => ({
      ...pageDocumentQuery(user?.id ?? null, spaceId ?? "", pageId, token),
      enabled: Boolean(spaceId && token),
    })),
  });
  const sectionTitles = useMemo(() => {
    const titles = new Map<string, string>();
    documents.forEach((document, index) => {
      for (const block of pageBlocks(document.data?.body ?? "")) {
        titles.set(`${pageIds[index]}#${block.id}`, block.title);
      }
    });
    return titles;
  }, [documents, pageIds]);
  const sectionTitle = (automation: SerializedAutomation) => automation.blockId === undefined ? null
    : sectionTitles.get(`${automation.pageId}#${automation.blockId}`) ?? sectionFallbackTitle(automation.blockId);
  const conversationTitle = (channelId: string) => {
    const channel = channels.find((item) => item.id === channelId);
    return channel ? channelTitle(channel) : undefined;
  };
  const whereTitle = (automation: SerializedAutomation) => automation.pageId
    ? pageTitles.get(automation.pageId) ?? "Untitled page"
    : `#${conversationTitle(automation.channelId) ?? automation.channelId}`;

  const groups = useMemo(() => groupSchedules(automations, executionEnabled), [automations, executionEnabled]);

  const selectedSpace = spaces.find((space) => space.id === spaceId);
  const memberMayCreate = spaceMemberCanCreate(selectedSpace, currentUserId, "automationCreation");

  // Opened for one Automation: choose it, with its editor.
  useEffect(() => {
    if (!focusAutomationId) return;
    const automation = automations.find((candidate) => candidate.id === focusAutomationId);
    if (!automation) {
      if (!loadingAutomations) onFocusConsumed?.();
      return;
    }
    select(automation.id, { replace: true });
    setEditingId(automation.capabilities.update ? automation.id : null);
    onFocusConsumed?.();
  }, [focusAutomationId, automations, loadingAutomations, onFocusConsumed, select]);
  // The editor belongs to the chosen Automation, while it can still be changed.
  useEffect(() => {
    if (editingId && (editingId !== selectedId ||
      !automations.some((automation) => automation.id === editingId && automation.capabilities.update))) {
      setEditingId(null);
    }
  }, [editingId, automations, selectedId]);

  const stateOf = (automation: SerializedAutomation) => scheduleState(automation, executionEnabled);
  const whenOf = (automation: SerializedAutomation) => automation.detachedAt ? "detached"
    : scheduleRunning(automation) ? nextRunPhrase(automation.nextRunAt, now) : "paused";

  // The group says what each one is doing, so a row needs no mark: what it is, where it lives, how often and when.
  const list = (
    <ToolList title="Schedules">
      {loadError && <p role="alert" className="px-4 pb-2 text-xs font-medium text-destructive md:px-5">{loadError}</p>}
      {loadingAutomations && automations.length === 0 ? (
        <ListSkeleton label="Loading schedules" rows={4} className="px-4 md:px-5" />
      ) : automations.length === 0 ? (
        loadError ? null : <p className="px-4 text-sm text-muted-foreground md:px-5">No schedules yet.</p>
      ) : groups.map((group) => (
        <ToolListGroup key={group.state} title={GROUP_TITLES[group.state]} count={group.automations.length}>
          {group.automations.map((automation) => (
            <ToolListRow key={automation.id} testId="schedule-row" state={group.state}
              selected={automation.id === selectedId}
              onSelect={() => select(automation.id)}
              title={automation.name}
              end={group.state === "paused" ? undefined : whenOf(automation)}
              subtitle={group.state === "attention" ? scheduleAttention(automation, executionEnabled)
                : `${whereTitle(automation)} · ${formatAutomationCadence(automation.intervalMinutes)}`} />
          ))}
        </ToolListGroup>
      ))}
    </ToolList>
  );

  const detail = selected ? (
    <ScheduleDetail
      key={selected.id}
      automation={selected}
      state={stateOf(selected)}
      where={whereTitle(selected)}
      section={sectionTitle(selected)}
      now={now}
      executionEnabled={executionEnabled}
      currentUserId={currentUserId}
      memberMayCreate={memberMayCreate}
      spaceName={selectedSpace?.name}
      busy={busy}
      error={error}
      editing={editingId === selected.id}
      onBack={() => select(null)}
      onEditingChange={(editing) => setEditingId(editing ? selected.id : null)}
      onUpdate={(input) => {
        onUpdateAutomation(selected.id, input);
        setEditingId(null);
      }}
      onToggle={() => onToggleAutomation(selected)}
      onDelete={() => onDeleteAutomation(selected)}
      onOpenWhere={() => selected.pageId ? onOpenPage(selected.pageId) : onOpenConversation(selected.channelId)}
      onOpenConversation={() => onOpenConversation(selected.channelId)}
    />
  ) : automations.length === 0 && !loadingAutomations && !loadError ? (
    <ToolDetailEmpty icon={<Clock />} title="Nothing in this Space runs on a schedule">
      <p>
        An Automation keeps one section of a page true, and is made there: open a page and schedule it from the
        section it should keep up to date. Everything that runs is listed here.
      </p>
      <Button size="sm" variant="outline" onClick={onOpenPages}><FileText /> Open Pages</Button>
    </ToolDetailEmpty>
  ) : (
    <ScheduleOverview
      automations={automations}
      summary={summary}
      executionEnabled={executionEnabled}
      error={error}
      now={now}
      where={whereTitle}
      onSelect={(automation) => select(automation.id)}
    />
  );

  return <ToolSplit label="Schedules" open={Boolean(selected)} list={list} detail={detail} />;
}

function nextRunPhrase(nextRunAt: string, now: number): string {
  void now; // formatAutomationNext reads the clock; `now` only re-renders it.
  return formatAutomationNext(nextRunAt).replace(/^next (?:run )?/u, "") || "unscheduled";
}

function ExecutionUnavailable() {
  return (
    <p role="alert" className={noticeClass("alert", "rounded-lg p-3 text-sm")}>
      Scheduled runs are unavailable. Nothing will run, and nothing can be resumed, until execution is enabled.
    </p>
  );
}

/** With nothing chosen: what needs a person, then what runs next. */
function ScheduleOverview({ automations, summary, executionEnabled, error, now, where, onSelect }: {
  automations: SerializedAutomation[];
  summary: ReturnType<typeof scheduleSummary>;
  executionEnabled: boolean | null;
  error: string | null;
  now: number;
  where: (automation: SerializedAutomation) => string;
  onSelect: (automation: SerializedAutomation) => void;
}) {
  const attention = automations.filter((automation) => scheduleAttention(automation, executionEnabled));
  const upcoming = automations.filter(scheduleRunning)
    .sort((left, right) => Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt)).slice(0, 8);
  return (
    <ToolDetail title="Schedules"
      status={<span data-testid="schedules-summary">
        {summary.running} running, {summary.paused} paused
        {summary.pages > 0 ? ` on ${summary.pages} ${summary.pages === 1 ? "page" : "pages"}` : ""}
      </span>}>
      {executionEnabled === false && <ExecutionUnavailable />}
      {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
      {attention.length > 0 && (
        <ToolDetailSection title="Needs attention">
          <ul className="app-tool-lines">
            {attention.map((automation) => (
              <li key={automation.id} className="py-2">
                <button type="button" onClick={() => onSelect(automation)}
                  className="flex w-full min-w-0 items-start gap-2 text-left">
                  <AlertTriangle className="app-ink-attention mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{automation.name}
                      <span className="font-normal text-muted-foreground"> · {where(automation)}</span></span>
                    <span className="block break-words text-xs text-muted-foreground">
                      {scheduleAttention(automation, executionEnabled)}
                    </span>
                  </span>
                  <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        </ToolDetailSection>
      )}
      <ToolDetailSection title="Up next">
        {upcoming.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is running.</p>
        ) : (
          <ul className="app-tool-lines">
            {upcoming.map((automation) => (
              <li key={automation.id}>
                <button type="button" onClick={() => onSelect(automation)}
                  className="flex w-full min-w-0 items-baseline gap-3 py-2 text-left">
                  <span className="w-24 shrink-0 text-sm tabular-nums" title={formatDateTime(automation.nextRunAt)}>
                    {nextRunPhrase(automation.nextRunAt, now)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-semibold">{automation.name}</span>
                  <span className="hidden min-w-0 max-w-[40%] truncate text-xs text-muted-foreground sm:block">
                    {where(automation)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ToolDetailSection>
      <p className="text-xs text-muted-foreground">
        Automations are made on a page, in the section they keep true. Choose one to pause, change or remove it.
      </p>
    </ToolDetail>
  );
}

function ScheduleDetail({
  automation,
  state,
  where,
  section,
  now,
  executionEnabled,
  currentUserId,
  memberMayCreate,
  spaceName,
  busy,
  error,
  editing,
  onBack,
  onEditingChange,
  onUpdate,
  onToggle,
  onDelete,
  onOpenWhere,
  onOpenConversation,
}: {
  automation: SerializedAutomation;
  state: ScheduleState;
  where: string;
  section: string | null;
  now: number;
  executionEnabled: boolean | null;
  currentUserId: string;
  memberMayCreate: boolean;
  spaceName?: string;
  busy: string | null;
  error: string | null;
  editing: boolean;
  onBack: () => void;
  onEditingChange: (editing: boolean) => void;
  onUpdate: (input: Omit<AutomationUpdateRequest, "expectedVersion">) => void;
  onToggle: () => void;
  onDelete: () => void;
  onOpenWhere: () => void;
  onOpenConversation: () => void;
}) {
  const running = scheduleRunning(automation);
  const attention = scheduleAttention(automation, executionEnabled);
  const triggers = automation.triggers ?? [];
  const lastRan = formatRelativeAge(automation.lastRunAt ?? automation.lastDeliveryAt, now);
  const canToggle = !automation.detachedAt &&
    (automation.enabled ? automation.capabilities.pause : automation.capabilities.resume);
  const readOnly = !automation.capabilities.update && !automation.capabilities.pause &&
    !automation.capabilities.resume && !automation.capabilities.delete;

  return (
    <ToolDetail
      onBack={onBack}
      backLabel="Schedules"
      context={
        <button type="button" onClick={onOpenWhere} className="flex min-w-0 items-center gap-1 hover:text-foreground hover:underline"
          title={automation.pageId ? "Open its page" : "Open the conversation"}>
          {automation.pageId ? <FileText className="size-3.5 shrink-0" /> : <MessageSquare className="size-3.5 shrink-0" />}
          <span className="truncate">{where}{section !== null ? ` › ${section}` : ""}</span>
        </button>
      }
      title={automation.name}
      status={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <ToolStateDot state={state} />
          <span className="text-foreground">{automation.detachedAt ? "Detached" : running ? "Running" : "Paused"}</span>
          <span>· {formatAutomationCadence(automation.intervalMinutes)}</span>
          {running && <span title={formatDateTime(automation.nextRunAt)}>· {formatAutomationNext(automation.nextRunAt)}</span>}
          <span>· {lastRan ? `ran ${lastRan}` : "not run yet"}</span>
        </span>
      }
      actions={
        <>
          {canToggle && (
            <Button size="sm" variant="outline" onClick={onToggle}
              disabled={Boolean(busy) || (!automation.enabled && executionEnabled !== true)}>
              {busy === `toggle:${automation.id}` ? <Loader2 className="animate-spin" />
                : automation.enabled ? <Pause /> : <Play />}
              {automation.enabled ? "Pause" : "Resume"}
            </Button>
          )}
          {automation.detachedAt && automation.pageId && (
            <Button size="sm" variant="outline" onClick={onOpenWhere}><FileText /> Put it back on its page</Button>
          )}
          <Button size="sm" variant="outline" onClick={onOpenConversation}><MessageSquare /> Conversation</Button>
          {automation.capabilities.update && !editing && (
            <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => onEditingChange(true)}>
              <Pencil /> Edit
            </Button>
          )}
          {automation.capabilities.delete && (
            <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={onDelete} title="Delete lineage"
              className="text-muted-foreground hover:text-destructive">
              {busy === `delete:${automation.id}` ? <Loader2 className="animate-spin" /> : <Trash2 />} Delete
            </Button>
          )}
          {readOnly && <span className="text-xs text-muted-foreground">Read only</span>}
        </>
      }
    >
      {executionEnabled === false && <ExecutionUnavailable />}
      {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
      {attention && (
        <p className={noticeClass("attention", "rounded-lg p-3 flex items-start gap-2 text-sm")}>
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> <span className="min-w-0 break-words">{attention}</span>
        </p>
      )}

      {editing ? (
        <ToolDetailSection title="Change it">
          <ScheduleEditor
            automation={automation}
            busy={busy}
            replacesOthers={automation.authorityRootUserId !== currentUserId}
            memberMayCreate={memberMayCreate}
            spaceName={spaceName}
            onCancel={() => onEditingChange(false)}
            onSave={onUpdate}
          />
        </ToolDetailSection>
      ) : (
        <ToolDetailSection title="What it does each time">
          <p className="whitespace-pre-wrap break-words text-sm leading-6">{automation.expression.text}</p>
        </ToolDetailSection>
      )}

      <ToolDetailSection title="When it runs">
        <ToolFacts>
          <ToolFact label="Cadence">{formatAutomationCadence(automation.intervalMinutes)}</ToolFact>
          {running && <ToolFact label="Next">{formatDateTime(automation.nextRunAt)}</ToolFact>}
          {triggers.length > 0 && (
            <ToolFact label="Also">{triggers.map(formatAutomationTrigger).join("; ")}</ToolFact>
          )}
        </ToolFacts>
      </ToolDetailSection>

      <ToolDetailSection title="History">
        <ToolFacts>
          <ToolFact label="Last run">
            {automation.lastRunAt ? formatDateTime(automation.lastRunAt) : "Not yet"}
            {automation.lastRunStatus ? ` · ${automation.lastRunStatus}` : ""}
          </ToolFact>
          {automation.lastDeliveryAt && <ToolFact label="Last delivered">{formatDateTime(automation.lastDeliveryAt)}</ToolFact>}
          <ToolFact label="Delivered">{automation.deliveryCount} {automation.deliveryCount === 1 ? "time" : "times"}</ToolFact>
          <ToolFact label="Created">{formatDateTime(automation.createdAt)}</ToolFact>
          <ToolFact label="Binding">{evaluationBindingLabel(automation.input)}</ToolFact>
        </ToolFacts>
      </ToolDetailSection>
    </ToolDetail>
  );
}

/** Changes what an Automation does and how often; where it lives is its page's business. */
function ScheduleEditor({ automation, busy, replacesOthers, memberMayCreate, spaceName, onCancel, onSave }: {
  automation: SerializedAutomation;
  busy: string | null;
  replacesOthers: boolean;
  memberMayCreate: boolean;
  spaceName?: string;
  onCancel: () => void;
  onSave: (input: Omit<AutomationUpdateRequest, "expectedVersion">) => void;
}) {
  const [name, setName] = useState(automation.name);
  const [intervalMinutes, setIntervalMinutes] = useState(automation.intervalMinutes);
  const [instruction, setInstruction] = useState(automation.expression.text);
  const saving = busy === `edit:${automation.id}`;
  // Saving someone else's Automation makes one of your own in its place, which the Space's policy governs.
  const allowed = !replacesOthers || memberMayCreate;
  const canSave = allowed && !busy && name.trim().length > 0 && instruction.trim().length > 0 &&
    isAutomationIntervalMinutes(intervalMinutes);
  return (
    <form className="space-y-3" onSubmit={(event) => {
      event.preventDefault();
      if (canSave) onSave({ name: name.trim(), expression: automationExpressionFromText(instruction), intervalMinutes });
    }}>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <label className="block text-xs font-bold text-muted-foreground">
          Name
          <Input value={name} onChange={(event) => setName(event.target.value)} className="mt-1" />
        </label>
        <label className="block text-xs font-bold text-muted-foreground">
          Every (minutes)
          <Input type="number" min={AUTOMATION_MIN_INTERVAL_MINUTES} max={AUTOMATION_MAX_INTERVAL_MINUTES}
            step={15} inputMode="numeric" value={intervalMinutes}
            onChange={(event) => setIntervalMinutes(Number(event.target.value))} className="mt-1" />
        </label>
      </div>
      <label className="block text-xs font-bold text-muted-foreground">
        What it does each time
        <Textarea value={instruction} onChange={(event) => setInstruction(event.target.value)}
          className="mt-1 min-h-32 resize-y text-sm font-normal text-foreground" />
        <AutomationExpressionGuidance compact />
      </label>
      {replacesOthers && (
        <p className={noticeClass("attention", "rounded-lg p-3 text-xs")}>
          {memberMayCreate
            ? "Saving replaces this schedule with your own copy, which runs as you."
            : `Only owners and admins can create Automations in ${spaceName ?? "this Space"}, so only its author can change this one.`}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={!canSave}>
          {saving && <Loader2 className="animate-spin" />} Save changes
        </Button>
        <Button size="sm" variant="ghost" type="button" disabled={saving} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
