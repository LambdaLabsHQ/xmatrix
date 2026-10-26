"use client";

import type { Components } from "react-markdown";
import { Ban, CircleCheck, CircleMinus, CircleX, Clock, Lock } from "lucide-react";
import type { ConnectorReceiptEntry, ConnectorReceiptStatus } from "@xmatrix/protocol";
import { statusInkClass, type StatusTone } from "@/components/ui/status-tone";
import { RichMessageContent } from "./workspace-shell-rich-message";

const OUTCOMES: Record<ConnectorReceiptStatus, { label: string; tone: StatusTone; Icon: typeof CircleCheck }> = {
  completed: { label: "Completed", tone: "settled", Icon: CircleCheck },
  failed: { label: "Failed", tone: "alert", Icon: CircleX },
  blocked: { label: "Blocked", tone: "alert", Icon: Ban },
  denied: { label: "Denied", tone: "alert", Icon: Ban },
  queued: { label: "Queued", tone: "attention", Icon: Clock },
  ignored: { label: "Ignored", tone: "secondary", Icon: CircleMinus },
};

/**
 * What an App answered a connector command with, drawn as a tool call's result rather than as prose: per
 * statement, what ran and how it ended, then what it returned. A private call's result went only to its caller,
 * so the card says that instead of showing a mask.
 */
export function ConnectorReceiptCard({ entries, collapsed = false, components }: {
  entries: readonly ConnectorReceiptEntry[];
  /** A long receipt folds its results, as a long message folds its text, under the row's "Show more". */
  collapsed?: boolean;
  components: Components;
}) {
  return (
    <div className="app-connector-receipt" data-testid="connector-receipt">
      {entries.map((entry, index) => {
        const outcome = entry.status ? OUTCOMES[entry.status] : undefined;
        return (
          <div key={index} className="app-connector-receipt-entry" data-status={entry.status ?? "unknown"}>
            {(entry.subject || outcome) && (
              <p className="app-connector-receipt-head">
                {outcome && <outcome.Icon aria-hidden="true" className={statusInkClass(outcome.tone)} />}
                {entry.subject && <span className="app-connector-receipt-subject">{entry.subject}</span>}
                {outcome && <span className={statusInkClass(outcome.tone, "app-connector-receipt-status")}>{outcome.label}</span>}
              </p>
            )}
            {entry.private ? (
              <p className="app-connector-receipt-private">
                <Lock aria-hidden="true" />
                Private result: only the caller received it
              </p>
            ) : entry.detail ? (
              <div className="app-connector-receipt-detail">
                <RichMessageContent body={entry.detail} collapsed={collapsed} components={components} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
