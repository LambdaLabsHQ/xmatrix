"use client";

import { useEffect, useState } from "react";
import { LifeBuoy } from "lucide-react";
import { SUPPORT_HANDOFF_DAYS, SUPPORT_HANDOFF_LINE_MAX, type SupportHandoff, type SupportHandoffPart } from "@xmatrix/protocol";

import { Input } from "@/components/ui/input";
import {
  closeSupportHandoff, emptySupportHandoffDraft, sendSupportHandoff, supportHandoffRequestOf,
  useSupportHandoffTarget, type SupportHandoffDraft,
} from "@/lib/support-handoff";
import { userErrorMessage } from "@/lib/user-facing-error";
import { CenteredDialogShell, DialogButton, DialogInset, DialogPanelFooter, DialogPanelHeader } from "./centered-dialog-shell";

/** What each box includes, in the words the person reads before ticking it. */
export const SUPPORT_HANDOFF_CHOICES: ReadonlyArray<{ part: SupportHandoffPart; label: string; detail: string }> = [
  { part: "messages", label: "This conversation's messages",
    detail: "Everything said here, including its threads, as you can read it." },
  { part: "diagnostics", label: "Diagnostics for this conversation",
    detail: "When Agents started, stopped or failed here, and the failure codes. No message text." },
];

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

  useEffect(() => {
    // Each conversation's handoff starts from nothing ticked.
    setDraft(emptySupportHandoffDraft());
    setError(null);
    setSent(null);
  }, [target?.channelId]);

  if (!target) return null;
  const request = supportHandoffRequestOf(draft);
  const tick = (part: SupportHandoffPart, checked: boolean) =>
    setDraft((current) => ({ ...current, parts: { ...current.parts, [part]: checked } }));

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
