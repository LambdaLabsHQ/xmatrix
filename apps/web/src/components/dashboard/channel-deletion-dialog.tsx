"use client";

import { useEffect, useRef, useState } from "react";
import { WEB_PROXY_ROUTES, type ChannelSnapshot } from "@xmatrix/protocol";
import { XMatrixApiError, xmatrixApiRequest } from "@/lib/query/api-client";
import { userErrorMessage } from "@/lib/user-facing-error";
import { channelTitle } from "./channel-links";
import { CenteredDialogShell, DialogButton, DialogPanelHeader, DialogPanelFooter } from "./centered-dialog-shell";

export function ChannelDeletionDialog({ channel, token, onCancel, onDeleted }: {
  channel: ChannelSnapshot; token?: string; onCancel: () => void; onDeleted: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const stopMessageId = useRef<string | null>(null);
  useEffect(() => () => operation.current?.abort(), []);

  async function submit() {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    const { signal } = controller;
    const timeout = setTimeout(() => controller.abort(new DOMException("Deletion timed out", "TimeoutError")), 30_000);
    setBusy(true); setError(null);
    try {
      if (confirmStop) {
        // Reuse the visible, authorized stop command and its daemon receipts.
        // An uncertain append retries with the same id instead of stopping twice.
        stopMessageId.current ??= crypto.randomUUID();
        await xmatrixApiRequest({ url: WEB_PROXY_ROUTES.channel_messages(channel.id), token, method: "POST", signal,
          body: { body: "/stop all", clientMessageId: stopMessageId.current } });
        stopMessageId.current = null;
      }
      for (;;) {
        signal.throwIfAborted();
        try {
          await xmatrixApiRequest({ url: WEB_PROXY_ROUTES.channel_deletion(channel.spaceId, channel.id), token,
            method: "POST", signal, body: { name: channel.name, confirmation: "DELETE", acknowledge: true } });
          break;
        } catch (cause) {
          if (!confirmStop || !activeWork(cause)) throw cause;
          // Retirement remains blocked until the host confirms termination and
          // pending launches and allocations have been released.
          await new Promise(resolve => setTimeout(resolve, 1_000));
        }
      }
      onDeleted(channel.id);
    } catch (cause) {
      if (activeWork(cause)) setConfirmStop(true);
      else if (signal.reason?.name !== "AbortError") setError(signal.reason?.name === "TimeoutError" && confirmStop
        ? "Stopping Agents and deleting this Channel took too long. If a machine is offline, reconnect it, then try again."
        : userErrorMessage(cause, "That didn't work"));
    } finally {
      clearTimeout(timeout);
      operation.current = null;
      setBusy(false);
    }
  }
  return <CenteredDialogShell open busy={busy} labelledBy="channel-deletion-title" onCancel={onCancel} panelClassName="max-w-sm">
    <DialogPanelHeader labelledBy="channel-deletion-title" title={`Delete #${channelTitle(channel)}?`} />
    <div className="space-y-3 px-5 py-4 text-sm">
      <p>Its messages are deleted for everyone. Linked Pages stay. This cannot be undone.</p>
      {confirmStop && <p>Agents still have work in this Channel. Stop all of them and delete it? Their current work will end.</p>}
      {busy && confirmStop && <p role="status">Waiting for the Agents to stop…</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
    <DialogPanelFooter><DialogButton disabled={busy} onClick={onCancel}>Cancel</DialogButton>
      <DialogButton tone="destructive" busy={busy} disabled={busy} onClick={() => void submit()}>
        {confirmStop ? "Stop Agents and Delete" : "Delete"}
      </DialogButton></DialogPanelFooter>
  </CenteredDialogShell>;
}

function activeWork(cause: unknown): boolean {
  return cause instanceof XMatrixApiError && cause.code === "channel_deletion_active_work";
}
