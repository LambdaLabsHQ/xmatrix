"use client";

import { useState } from "react";
import { WEB_PROXY_ROUTES, type ChannelSnapshot } from "@xmatrix/protocol";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { userErrorMessage } from "@/lib/user-facing-error";
import { CenteredDialogShell, DialogButton, DialogPanelHeader, DialogPanelFooter } from "./centered-dialog-shell";

export function ChannelDeletionDialog({ channel, onCancel, onDeleted }: {
  channel: ChannelSnapshot; onCancel: () => void; onDeleted: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (busy || name !== channel.name || !acknowledge) return;
    setBusy(true); setError(null);
    try {
      await xmatrixApiRequest({ url: WEB_PROXY_ROUTES.channel_deletion(channel.spaceId, channel.id), method: "POST",
        body: { name, confirmation: "DELETE", acknowledge } });
      onDeleted(channel.id);
    } catch (cause) { setError(userErrorMessage(cause, "That didn't work")); }
    finally { setBusy(false); }
  }
  return <CenteredDialogShell open busy={busy} labelledBy="channel-deletion-title" onCancel={onCancel} panelClassName="max-w-md">
    <DialogPanelHeader labelledBy="channel-deletion-title" title="Delete Channel" />
    <div className="space-y-4 px-5 py-4 text-sm">
      <p>This permanently deletes this Channel, its messages, attachments and schedules for everyone. Linked Pages remain. Stop its Agents before continuing.</p>
      <p>Access ends immediately. Data cleanup continues automatically. This cannot be undone.</p>
      <label className="block space-y-2"><span>Type <strong>{channel.name}</strong> to confirm</span>
        <input autoFocus value={name} disabled={busy} onChange={event => setName(event.target.value)}
          autoComplete="off" className="w-full rounded-md border border-border bg-background px-3 py-2" /></label>
      <label className="flex items-start gap-2"><input type="checkbox" checked={acknowledge} disabled={busy}
        onChange={event => setAcknowledge(event.target.checked)} /><span>I understand this deletes the Channel for all members.</span></label>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
    <DialogPanelFooter><DialogButton disabled={busy} onClick={onCancel}>Cancel</DialogButton>
      <DialogButton tone="destructive" busy={busy} disabled={busy || name !== channel.name || !acknowledge}
        onClick={() => void submit()}>Delete Channel</DialogButton></DialogPanelFooter>
  </CenteredDialogShell>;
}
