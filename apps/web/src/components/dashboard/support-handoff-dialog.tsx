"use client";

import { useEffect, useRef, useState } from "react";
import { LifeBuoy } from "lucide-react";
import { SUPPORT_HANDOFF_DAYS, SUPPORT_HANDOFF_LINE_MAX, type SupportHandoff, type SupportHandoffPart } from "@xmatrix/protocol";

import { Input } from "@/components/ui/input";
import {
  closeSupportHandoff, emptySupportHandoffDraft, readSupportLogExcerpt, sendSupportHandoff, supportHandoffRequestOf,
  supportLogMachines, useSupportHandoffTarget, type SupportHandoffDraft, type SupportLogMachine,
} from "@/lib/support-handoff";
import { userErrorMessage } from "@/lib/user-facing-error";
import { CenteredDialogShell, DialogButton, DialogInset, DialogPanelFooter, DialogPanelHeader } from "./centered-dialog-shell";
import { fetchMachineDaemons } from "./workspace-admin-views";

/** What each box includes, in the words the person reads before ticking it. */
export const SUPPORT_HANDOFF_CHOICES: ReadonlyArray<{ part: SupportHandoffPart; label: string; detail: string }> = [
  { part: "messages", label: "This conversation's messages",
    detail: "Everything said here, including its threads, as you can read it." },
  { part: "diagnostics", label: "Diagnostics for this conversation",
    detail: "When Agents started, stopped or failed here, and the failure codes. No message text." },
  { part: "logs", label: "Daemon logs",
    detail: "The recent lines xMatrix's daemon wrote on your machine. Home folders, emails, web address queries and " +
      "anything like a key are removed on your machine, and you see them here before sending." },
];

/** Reading the daemon log for the preview: which Machine, and how it went. */
interface LogPreview {
  machines: SupportLogMachine[];
  machineId?: string;
  reading: boolean;
  problem?: string;
}

/**
 * Hand to xMatrix support (docs/cross-space-read-grants.md#support-handoffs).
 * Every box starts unticked and nothing is sent until the person agrees.
 */
export function SupportHandoffDialog({ token }: { token: string | null | undefined }) {
  const target = useSupportHandoffTarget();
  const [draft, setDraft] = useState<SupportHandoffDraft>(emptySupportHandoffDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<SupportHandoff | null>(null);
  const [logs, setLogs] = useState<LogPreview>({ machines: [], reading: false });
  const logRead = useRef<AbortController | null>(null);

  useEffect(() => {
    // Each conversation's handoff starts from nothing ticked.
    setDraft(emptySupportHandoffDraft());
    setError(null);
    setSent(null);
    setLogs({ machines: [], reading: false });
    return () => logRead.current?.abort();
  }, [target?.channelId]);

  if (!target) return null;
  const request = supportHandoffRequestOf(draft);
  const untickLogs = () =>
    setDraft((current) => ({ ...current, parts: { ...current.parts, logs: false }, logExcerpt: undefined }));

  /** Tick logs: ask one of the person's online Machines for its redacted tail and show it before sending. */
  async function previewLogs(preferred?: string) {
    if (!token) return;
    logRead.current?.abort();
    const controller = new AbortController();
    logRead.current = controller;
    setDraft((current) => ({ ...current, parts: { ...current.parts, logs: true }, logExcerpt: undefined }));
    setLogs((current) => ({ ...current, reading: true, problem: undefined }));
    try {
      const machines = supportLogMachines(await fetchMachineDaemons(token, controller.signal));
      const machineId = machines.find((machine) => machine.machineId === preferred)?.machineId ?? machines[0]?.machineId;
      if (!machineId) {
        untickLogs();
        setLogs({ machines, reading: false,
          problem: "None of your machines is online, so there are no daemon logs to include." });
        return;
      }
      setLogs({ machines, machineId, reading: true });
      const excerpt = await readSupportLogExcerpt(token, machineId, controller.signal);
      if (controller.signal.aborted) return;
      setDraft((current) => current.parts.logs ? { ...current, logExcerpt: excerpt } : current);
      setLogs((current) => ({ ...current, reading: false }));
    } catch (readError) {
      if (controller.signal.aborted) return;
      untickLogs();
      setLogs((current) => ({ ...current, reading: false,
        problem: userErrorMessage(readError, "Couldn't read your daemon logs") ?? undefined }));
    }
  }

  const tick = (part: SupportHandoffPart, checked: boolean) => {
    if (part !== "logs") {
      setDraft((current) => ({ ...current, parts: { ...current.parts, [part]: checked } }));
    } else if (checked) {
      void previewLogs(logs.machineId);
    } else {
      logRead.current?.abort();
      untickLogs();
      setLogs((current) => ({ ...current, reading: false, problem: undefined }));
    }
  };
  const machineLabel = logs.machines.find((machine) => machine.machineId === logs.machineId)?.label;

  async function send() {
    if (!target || !token || !request) return;
    setBusy(true);
    setError(null);
    try {
      setSent((await sendSupportHandoff(token, target.channelId, request)).handoff);
    } catch (sendError) {
      setError(userErrorMessage(sendError, "Couldn't hand this conversation to support"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CenteredDialogShell open busy={busy} labelledBy="support-handoff-title" onCancel={closeSupportHandoff}
      panelClassName="max-w-md">
      <DialogPanelHeader labelledBy="support-handoff-title" title="Hand to xMatrix support"
        {...(target.channelName ? { subtitle: target.channelName } : {})} />
      {sent ? (
        <div className="space-y-2 px-5 py-4 text-sm" data-testid="support-handoff-sent">
          <p className="font-semibold">Sent. xMatrix support will look into it.</p>
          <p className="text-muted-foreground">
            Support can read what you selected until {new Date(sent.expiresAt).toLocaleDateString()}. This conversation
            shows each time they read it, and their answer arrives here. Withdraw it any time from the note in this
            conversation.
          </p>
        </div>
      ) : (
        <form className="max-h-[60dvh] space-y-4 overflow-y-auto px-5 py-4 text-sm" data-testid="support-handoff-form"
          onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <label className="block space-y-1.5">
            <span className="font-semibold">What went wrong?</span>
            <Input value={draft.line} maxLength={SUPPORT_HANDOFF_LINE_MAX} autoFocus disabled={busy}
              placeholder="One line is enough" aria-required="true"
              onChange={(event) => setDraft((current) => ({ ...current, line: event.target.value }))} />
          </label>
          <fieldset className="space-y-2">
            <legend className="font-semibold">Include, if you want</legend>
            {SUPPORT_HANDOFF_CHOICES.map((choice) => (
              <label key={choice.part} className="flex cursor-pointer items-start gap-2">
                <input type="checkbox" className="mt-1" checked={draft.parts[choice.part]} disabled={busy}
                  data-support-part={choice.part} onChange={(event) => tick(choice.part, event.target.checked)} />
                <span>{choice.label}<span className="block text-xs text-muted-foreground">{choice.detail}</span></span>
              </label>
            ))}
            {draft.parts.logs && logs.machines.length > 1 && (
              <label className="ml-6 flex items-center gap-2 text-xs">
                From
                <select value={logs.machineId ?? ""} disabled={busy} data-support-log-machine
                  className="rounded border bg-background px-1.5 py-1"
                  onChange={(event) => void previewLogs(event.target.value)}>
                  {logs.machines.map((machine) => (
                    <option key={machine.machineId} value={machine.machineId}>{machine.label}</option>
                  ))}
                </select>
              </label>
            )}
            {draft.parts.logs && logs.reading && (
              <p className="ml-6 text-xs text-muted-foreground" role="status">
                Reading the recent daemon log{machineLabel ? ` on ${machineLabel}` : ""}…
              </p>
            )}
            {draft.parts.logs && draft.logExcerpt !== undefined && (
              <div className="ml-6 space-y-1">
                <p className="text-xs text-muted-foreground">
                  This is exactly what support will read{machineLabel ? `, from ${machineLabel}` : ""}:
                </p>
                <pre data-support-log-preview aria-label="Daemon logs to send" tabIndex={0}
                  className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-snug">
                  {draft.logExcerpt}
                </pre>
              </div>
            )}
            {logs.problem && <p role="alert" className="ml-6 text-xs text-destructive">{logs.problem}</p>}
          </fieldset>
          <DialogInset className="space-y-2">
            <label className="flex cursor-pointer items-start gap-2 font-semibold">
              <input type="checkbox" className="mt-1" checked={draft.consent} disabled={busy} aria-required="true"
                data-support-consent onChange={(event) => setDraft((current) => ({ ...current, consent: event.target.checked }))} />
              I agree to let xMatrix support read what I selected
            </label>
            <p className="text-xs text-muted-foreground">
              Who reads it: xMatrix support, which is the xMatrix team and its support Agents. For how long:{" "}
              {SUPPORT_HANDOFF_DAYS} days. They can only read it, never change or send anything here. You can
              withdraw it any time, and this conversation shows each time support reads it.
            </p>
          </DialogInset>
          {error && <p role="alert" className="text-xs font-semibold text-destructive">{error}</p>}
        </form>
      )}
      <DialogPanelFooter>
        <DialogButton onClick={closeSupportHandoff} disabled={busy}>{sent ? "Close" : "Cancel"}</DialogButton>
        {!sent && (
          <DialogButton tone="primary" icon={LifeBuoy} busy={busy} disabled={!request || !token}
            onClick={() => void send()}>
            Send to support
          </DialogButton>
        )}
      </DialogPanelFooter>
    </CenteredDialogShell>
  );
}
