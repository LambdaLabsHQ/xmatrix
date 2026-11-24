"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LifeBuoy, Loader2, Send, X } from "lucide-react";
import type { ClientDefectAction, SupportHandoffPart } from "@xmatrix/protocol";

import { actionClass } from "@/components/ui/action-tone";
import { Textarea } from "@/components/ui/textarea";
import {
  openSupportHandoff, readSupportHandoff, readSupportHandoffPart, replyToSupportHandoff, revokeSupportHandoff,
  type SupportHandoffPartRead, supportHandoffCardOf,
} from "@/lib/support-handoff";
import { userErrorMessage } from "@/lib/user-facing-error";

type SupportHandoffCardData = NonNullable<ReturnType<typeof supportHandoffCardOf>>;

const PART_LABEL: Record<SupportHandoffPart, string> = {
  messages: "Read the conversation", diagnostics: "Diagnostics", logs: "Daemon logs",
};

const STATUS_LABEL = { approved: "Support can read it", revoked: "Withdrawn", expired: "Expired" } as const;

/**
 * The cards a support handoff posts (docs/cross-space-read-grants.md#support-handoffs):
 * in the person's conversation, a receipt they (or their Space's admins) can
 * withdraw; in the support conversation, the parts support may read and the
 * box that answers the person. The Hub decides who sees what; a card a viewer
 * may not act on shows only its text.
 */
export function SupportHandoffCard({ card, body, token, userId }: {
  card: SupportHandoffCardData;
  body: React.ReactNode;
  token: string | null | undefined;
  userId: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["support-handoff", userId, card.spaceId, card.grantId];
  const handoffQuery = useQuery({
    queryKey, enabled: Boolean(token), retry: false,
    queryFn: async ({ signal }) => {
      try { return (await readSupportHandoff(token!, card.spaceId, card.grantId, signal)).handoff; }
      catch { return null; }
    },
  });
  const handoff = handoffQuery.data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [read, setRead] = useState<{ part: SupportHandoffPart; result: SupportHandoffPartRead } | null>(null);
  const [reply, setReply] = useState("");
  const [replied, setReplied] = useState(false);

  async function act(work: () => Promise<void>, failure: ClientDefectAction) {
    setBusy(true);
    setError(null);
    try { await work(); } catch (actionError) { setError(userErrorMessage(actionError, failure)); }
    finally { setBusy(false); }
  }

  const live = handoff?.status === "approved";
  const support = handoff?.viewerRole === "support";
  const canWithdraw = live && (handoff.viewerRole === "owner" || handoff.viewerRole === "admin");
  return (
    <div className="space-y-2" data-testid="support-handoff-card">
      {body}
      {handoff && (
        <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <LifeBuoy className="size-3.5" />
          {STATUS_LABEL[handoff.status]}
          {live && <> · until {new Date(handoff.expiresAt).toLocaleDateString()} · {handoff.readCount} reads</>}
        </p>
      )}
      {canWithdraw && (
        <button type="button" disabled={busy} className={actionClass({ variant: "secondary", size: "sm" })}
          onClick={() => void act(async () => {
            const next = (await revokeSupportHandoff(token!, card.spaceId, card.grantId)).handoff;
            queryClient.setQueryData(queryKey, { ...handoff, ...next });
          }, "Couldn't withdraw support access")}>
          {busy ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
          Withdraw now
        </button>
      )}
      {support && live && card.parts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {card.parts.map((part) => (
            <button key={part} type="button" disabled={busy} className={actionClass({ variant: "secondary", size: "sm" })}
              onClick={() => void act(async () => {
                setRead({ part, result: await readSupportHandoffPart(token!, card.spaceId, card.grantId, part) });
              }, "Couldn't read this support handoff")}>
              {PART_LABEL[part]}
            </button>
          ))}
        </div>
      )}
      {read && <SupportHandoffPartView read={read} />}
      {support && live && (
        <form className="space-y-2" onSubmit={(event) => {
          event.preventDefault();
          if (!reply.trim()) return;
          void act(async () => {
            await replyToSupportHandoff(token!, card.spaceId, card.grantId, reply.trim());
            setReply("");
            setReplied(true);
          }, "Couldn't send the answer to the person");
        }}>
          <Textarea value={reply} maxLength={4000} disabled={busy} placeholder="Answer them as xMatrix support"
            onChange={(event) => { setReply(event.target.value); setReplied(false); }} />
          <button type="submit" disabled={busy || !reply.trim()} className={actionClass({ variant: "primary", size: "sm" })}>
            <Send className="size-3.5" />
            {replied ? "Sent to their conversation" : "Send to their conversation"}
          </button>
        </form>
      )}
      {error && <p role="alert" className="text-xs font-semibold text-destructive">{error}</p>}
    </div>
  );
}

function SupportHandoffPartView({ read }: { read: { part: SupportHandoffPart; result: SupportHandoffPartRead } }) {
  const { part, result } = read;
  if (part === "logs") {
    return <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 font-mono text-xs">
      {result.logExcerpt || "No log lines."}</pre>;
  }
  if (part === "diagnostics") {
    const events = result.diagnostics ?? [];
    return (
      <ul className="max-h-64 space-y-1 overflow-auto font-mono text-xs">
        {events.length === 0 && <li>No executions recorded.</li>}
        {events.map((event, index) => (
          <li key={index}>
            {new Date(event.createdAt).toISOString().slice(0, 16).replace("T", " ")}{" "}
            {event.kind === "launch"
              ? `start ${event.state}${event.errorCode ? ` · ${event.errorCode}` : ""}${event.errorStage ? ` at ${event.errorStage}` : ""} · attempt ${event.attempt}`
              : `run ${event.status}`}
          </li>
        ))}
      </ul>
    );
  }
  const messages = [...(result.history?.messages ?? [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  return (
    <ol className="max-h-80 space-y-2 overflow-auto rounded bg-muted/40 p-2 text-xs">
      {messages.length === 0 && <li>No messages.</li>}
      {messages.map((message, index) => (
        <li key={message.messageId ?? index}>
          <span className="font-semibold">{message.senderSnapshot?.name ?? "Someone"}</span>
          {message.sentAt && <span className="text-muted-foreground"> · {new Date(message.sentAt).toLocaleString()}</span>}
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        </li>
      ))}
    </ol>
  );
}

/** On xMatrix's own failure notices: hand this conversation to support from where it went wrong. */
export function SupportHandoffOffer({ channelId, channelName }: { channelId: string; channelName?: string }) {
  return (
    <button type="button" className={actionClass({ variant: "secondary", size: "sm" })}
      onClick={() => openSupportHandoff({ channelId, ...(channelName ? { channelName } : {}) })}>
      <LifeBuoy className="size-3.5" />
      Hand to xMatrix support
    </button>
  );
}
