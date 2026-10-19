"use client";

import { useState } from "react";
import { WEB_PROXY_ROUTES, type ChannelSnapshot } from "@xmatrix/protocol";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { userErrorMessage } from "@/lib/user-facing-error";
import { channelTitle } from "./channel-links";
import { CenteredDialogShell, DialogButton, DialogPanelHeader, DialogPanelFooter } from "./centered-dialog-shell";

export function ChannelDeletionDialog({ channel, onCancel, onDeleted }: {
  channel: ChannelSnapshot; onCancel: () => void; onDeleted: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      // Opening this dialog and pressing Delete is the confirmation.
      await xmatrixApiRequest({ url: WEB_PROXY_ROUTES.channel_deletion(channel.spaceId, channel.id), method: "POST",
        body: { name: channel.name, confirmation: "DELETE", acknowledge: true } });
      onDeleted(channel.id);
    } catch (cause) { setError(userErrorMessage(cause, "That didn't work")); }
    finally { setBusy(false); }
  }
  return <CenteredDialogShell open busy={busy} labelledBy="channel-deletion-title" onCancel={onCancel} panelClassName="max-w-sm">
    <DialogPanelHeader labelledBy="channel-deletion-title" title={`Delete #${channelTitle(channel)}?`} />
    <div className="space-y-3 px-5 py-4 text-sm">
      <p>Its messages are deleted for everyone. Linked Pages stay. This cannot be undone.</p>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
    <DialogPanelFooter><DialogButton disabled={busy} onClick={onCancel}>Cancel</DialogButton>
      <DialogButton tone="destructive" busy={busy} disabled={busy} onClick={() => void submit()}>Delete</DialogButton></DialogPanelFooter>
  </CenteredDialogShell>;
}
