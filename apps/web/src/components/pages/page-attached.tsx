"use client";

import { useState } from "react";
import type { AutomationTrigger, SerializedAutomation } from "@xmatrix/protocol";
import { Clock } from "lucide-react";
import { RepoOcticon } from "@/components/ui/octicons";
import { Button } from "@/components/ui/button";
import { GlassSelect } from "@/components/ui/glass-select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatAutomationCadence } from "./page-automation-format";

/** A new Automation for a section (docs/design/pages-live-document.md §6). */
export interface PageScheduleInput {
  name: string; instruction: string; intervalMinutes: number; blockId: string; triggers?: AutomationTrigger[];
}

/**
 * What is attached to one section (docs/design/pages-live-document.md §3.2):
 * a new Automation referenced in it, a repository whose issues and pull
 * requests arrive in a conversation linked to it, and the page's detached
 * Automations, which resume once their reference is back in the text. The
 * running ones are chips in the text; the Space's Schedules list them all.
 */
export function PageAttached({ automations, canEdit, onSchedule, onPutBack, onConnectGitHub, section,
  onAttached }: {
  automations: SerializedAutomation[];
  canEdit: boolean;
  onSchedule?: (input: PageScheduleInput) => Promise<void>;
  onPutBack?: (automation: SerializedAutomation, blockId: string) => Promise<void>;
  onConnectGitHub?: (input: { blockId: string; repository: string }) => Promise<void>;
  section: string;
  onAttached?: () => void;
}) {
  const [adding, setAdding] = useState<"schedule" | "github" | null>(null);
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [interval, setCadence] = useState("1440");
  const [repository, setRepository] = useState("");
  // Besides its cadence, an event may run it (docs/design/pages-live-document.md §6.2).
  const [event, setEvent] = useState<"" | Exclude<AutomationTrigger["kind"], "event">>("");
  const [eventRepository, setEventRepository] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detached = automations.filter((automation) => automation.detachedAt && automation.capabilities.update);
  const minutes = Number(interval);
  const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
  const repositoryValid = repositoryName.test(repository.trim());
  const eventValid = event === "" || event === "owed" || repositoryName.test(eventRepository.trim());
  const triggers = (): AutomationTrigger[] => event === "" ? [] : event === "owed" ? [{ kind: "owed" }]
    : [{ kind: event, repository: eventRepository.trim() }];
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const submit = () => act(async () => {
    if (adding === "schedule" && onSchedule) {
      const also = triggers();
      await onSchedule({ name: name.trim(), instruction: instruction.trim(), intervalMinutes: minutes, blockId: section,
        ...(also.length ? { triggers: also } : {}) });
    } else if (adding === "github" && onConnectGitHub) {
      await onConnectGitHub({ blockId: section, repository: repository.trim() });
    }
  }).then((done) => {
    if (!done) return;
    setAdding(null);
    setName("");
    setInstruction("");
    setRepository("");
    setEvent("");
    setEventRepository("");
    onAttached?.();
  });

  return (
    <div className="space-y-2" data-testid="page-attached">
      {canEdit && !adding && (onSchedule || onConnectGitHub) && (
        <div className="flex flex-wrap gap-2">
          {onSchedule && <Button size="xs" variant="outline" onClick={() => setAdding("schedule")}><Clock /> Schedule</Button>}
          {onConnectGitHub && (
            <Button size="xs" variant="outline" onClick={() => setAdding("github")}><RepoOcticon /> Connect GitHub</Button>
          )}
        </div>
      )}
      {adding && (
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {adding === "schedule" ? (
            <>
              <Input aria-label="Name" placeholder="Name, e.g. Code audit" value={name}
                onChange={(event) => setName(event.target.value)} />
              <Textarea aria-label="What to do each time" rows={3} value={instruction}
                placeholder="What to do each time, e.g. @auto repo:owner/repo audit and update this section"
                onChange={(event) => setInstruction(event.target.value)} />
              <GlassSelect aria-label="How often" value={interval} onChange={setCadence} options={[
                { value: "60", label: "Hourly" }, { value: "360", label: "Every 6 hours" },
                { value: "720", label: "Every 12 hours" }, { value: "1440", label: "Daily" },
                { value: "10080", label: "Weekly" },
              ]} />
              <GlassSelect aria-label="Also run" value={event} onChange={(value) => setEvent(value as typeof event)}
                options={[
                  { value: "", label: "Only on its cadence" },
                  { value: "merged", label: "Also when a pull request merges" },
                  { value: "ci-failed", label: "Also when a workflow fails" },
                  { value: "owed", label: "Also when its section owes an update" },
                ]} />
              {(event === "merged" || event === "ci-failed") && (
                <Input aria-label="Repository to watch" placeholder="owner/repo (its default branch)"
                  value={eventRepository} onChange={(item) => setEventRepository(item.target.value)} />
              )}
              <p className="text-xs text-muted-foreground">
                It is referenced in the section, runs in a conversation of its own, and anyone who can edit this page
                can change it.
              </p>
            </>
          ) : (
            <>
              <Input aria-label="Repository" placeholder="owner/repo" value={repository}
                onChange={(event) => setRepository(event.target.value)} />
              <p className="text-xs text-muted-foreground">
                Its issues and pull requests arrive in a conversation linked to this page.
              </p>
            </>
          )}
          <div className="flex gap-2">
            <Button size="xs" type="submit" disabled={busy || (adding === "schedule"
              ? !name.trim() || !instruction.trim() || !(minutes > 0) || !eventValid : !repositoryValid)}>
              {adding === "schedule" ? "Schedule" : "Connect"}
            </Button>
            <Button size="xs" variant="ghost" type="button" onClick={() => { setAdding(null); setError(null); }}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {canEdit && onPutBack && !adding && detached.length > 0 && (
        <ul className="space-y-1.5 border-t border-border/60 pt-2">
          {detached.map((automation) => (
            <li key={automation.id} className="flex items-center gap-1.5 text-xs" data-testid="page-automation">
              <Clock className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{automation.name}</span>
                <span className="text-muted-foreground"> · {formatAutomationCadence(automation.intervalMinutes)} · paused,
                  its reference left the page</span>
              </span>
              <Button size="xs" variant="outline" disabled={busy}
                onClick={() => void act(() => onPutBack(automation, section)).then((done) => done && onAttached?.())}>
                Put back here
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
