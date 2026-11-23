"use client";

import { useEffect, useState } from "react";
import {
  answerEmbedBrowserReadApproval,
  subscribeEmbedBrowserReadApprovals,
  type EmbedBrowserReadApproval,
} from "@/lib/extension-embed";
import { CenteredDialogShell, DialogButton, DialogPanelFooter, DialogPanelHeader } from "./centered-dialog-shell";

/**
 * An Agent asked to read a tab other than the page its conversation started
 * from (`xmatrix browse --tab`): the extension's side panel asks the person
 * first, here, and reads the tab only if they allow it. One request at a time;
 * later ones wait their turn.
 */
export function BrowserReadApprovalDialog() {
  const [queue, setQueue] = useState<EmbedBrowserReadApproval[]>([]);
  useEffect(() => subscribeEmbedBrowserReadApprovals((approval) =>
    setQueue((current) => current.some((item) => item.requestId === approval.requestId) ? current : [...current, approval])), []);
  const request = queue[0];
  if (!request) return null;
  const answer = (allow: boolean) => {
    answerEmbedBrowserReadApproval(request.requestId, allow);
    setQueue((current) => current.slice(1));
  };
  const host = new URL(request.href).host;
  return <CenteredDialogShell open busy={false} labelledBy="browser-read-title" onCancel={() => answer(false)} panelClassName="max-w-sm">
    <DialogPanelHeader labelledBy="browser-read-title" title={`Let ${request.agentName} read this tab?`} />
    <div className="space-y-2 px-5 py-4 text-sm">
      <p className="font-medium break-words">{request.title || host}</p>
      <p className="text-muted-foreground break-all">{request.href}</p>
      <p>Its text goes to {request.agentName} once. Nothing else in your browser is read.</p>
    </div>
    <DialogPanelFooter>
      <DialogButton onClick={() => answer(false)}>Don&apos;t allow</DialogButton>
      <DialogButton tone="primary" onClick={() => answer(true)}>Allow</DialogButton>
    </DialogPanelFooter>
  </CenteredDialogShell>;
}
