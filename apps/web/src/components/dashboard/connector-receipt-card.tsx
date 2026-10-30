"use client";

import type { Components } from "react-markdown";
import { Ban, CircleCheck, CircleMinus, CircleX, Clock, Lock } from "lucide-react";
import type { ConnectorReceiptEntry, ConnectorReceiptStatus } from "@xmatrix/protocol";
import { statusInkClass, type StatusTone } from "@/components/ui/status-tone";
import { RichMessageContent } from "./workspace-shell-rich-message";
import { PrivateConnectorResult } from "./private-connector-result";
import { parseGmailMessage } from "@/lib/gmail-message";
import { GmailMessageCard } from "./gmail-message-card";
import { splitConnectorResult } from "@/lib/connector-result";
import { ConnectorResultLinkAction } from "./connector-result-link";

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
 * statement, what ran and how it ended, then what it returned. Private results have a separate owner view;
 * a legacy call with no retained original stays caller-only.
 */
export function ConnectorReceiptCard({ entries, collapsed = false, components, privateResult }: {
  entries: readonly ConnectorReceiptEntry[];
  privateResult?: { channelId: string; messageId: string; ownerUserId: string; token: string | null };
  /** A long receipt folds its results, as a long message folds its text, under the row's "Show more". */
  collapsed?: boolean;
  components: Components;
}) {
  return (
    <div className="app-connector-receipt" data-testid="connector-receipt">
      {entries.map((entry, index) => {
        const outcome = entry.status ? OUTCOMES[entry.status] : undefined;
        const email = entry.private || !entry.detail ? undefined : parseGmailMessage(entry.detail);
        const result = entry.private || email || !entry.detail ? undefined : splitConnectorResult(entry.detail);
        return (
          <div key={index} className="app-connector-receipt-entry" data-status={entry.status ?? "unknown"}>
            {(entry.subject || outcome) && (
              <p className="app-connector-receipt-head">
                {outcome && <outcome.Icon aria-hidden="true" className={statusInkClass(outcome.tone)} />}
                {entry.subject && <span className="app-connector-receipt-subject">{entry.subject}</span>}
                {outcome && <span className={statusInkClass(outcome.tone, "app-connector-receipt-status")}>{outcome.label}</span>}
              </p>
            )}
            {entry.private && privateResult ? <PrivateConnectorResult {...privateResult} /> : entry.private ? (
              <p className="app-connector-receipt-private">
                <Lock aria-hidden="true" />
                Private result: only the caller received it
              </p>
            ) : email ? (
              <div className="app-connector-receipt-detail"><GmailMessageCard message={email} /></div>
            ) : result ? (
              <div className="app-connector-receipt-detail">
                <RichMessageContent body={result.body} collapsed={collapsed} components={components} />
                {result.link && <ConnectorResultLinkAction link={result.link} />}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
