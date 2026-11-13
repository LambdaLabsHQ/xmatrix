"use client";

import { useRef, useState } from "react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { Check, Loader2, MessageCircleQuestion, X } from "lucide-react";

import { AskCard, AskError } from "./ask-card";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { userErrorMessage } from "@/lib/user-facing-error";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";
import { errorFromResponse } from "@/lib/query/api-client";
import { actionClass } from "@/components/ui/action-tone";

/**
 * A request a Norn program made of a person (docs/architecture/norn-host.md).
 * The message carries what is asked and what an answer may be; only the
 * person it was delivered to sees the controls, and the Hub takes an answer
 * from nobody else. How it ended is the note the Hub records on the message.
 */
export interface NornRequestMetadata {
  ref: string;
  verb: string;
  holder: string;
  holderUserId: string;
  text: string;
  about: string | null;
  context: string | null;
  options: string[];
  by: string | null;
}

export function nornRequestMetadata(metadata: Record<string, unknown> | undefined): NornRequestMetadata | null {
  const value = metadata?.nornRequest;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = (field: unknown) => (typeof field === "string" && field.trim() ? field : undefined);
  const ref = text(record.ref), verb = text(record.verb), holder = text(record.holder), holderUserId = text(record.holderUserId);
  const asked = text(record.text);
  if (!ref || !verb || !holder || !holderUserId || !asked) return null;
  return { ref, verb, holder, holderUserId, text: asked, about: text(record.about) ?? null, context: text(record.context) ?? null,
    options: Array.isArray(record.options) ? record.options.filter((option): option is string => typeof option === "string") : [],
    by: text(record.by) ?? null };
}

/** An option the person completes before sending: `High(say why)` takes words of their own. */
const takesWords = (option: string) => option.includes("(");

export function NornRequestCard({ request, channelId, outcome, token, userId }: {
  request: NornRequestMetadata;
  channelId: string;
  /** How the request ended, once the Hub has said so on its message. */
  outcome?: string;
  token?: string | null;
  userId: string;
}) {
  const fetch = useXMatrixQueryFetch(userId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [words, setWords] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const isHolder = request.holderUserId === userId;
  const open = isHolder && !outcome && sent === null;
  const choices = request.verb === "confirm" ? ["Yes", "No"] : request.verb === "choose" ? request.options : [];
  // The field is there from the start when the answer is words; for a choice, once an option that takes words is picked.
  const [picked, setPicked] = useState<string | null>(null);
  const writing = choices.length === 0 || picked !== null;
  const field = useRef<HTMLTextAreaElement>(null);
  const pick = (choice: string) => {
    setPicked(choice);
    setWords(choice);
    requestAnimationFrame(() => field.current?.focus());
  };

  async function send(result: "answered" | "refused", text: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(WEB_PROXY_ROUTES.channel_norn_request_answer(channelId, request.ref), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ outcome: result, text }),
      });
      if (!response.ok) throw await errorFromResponse(response);
      const taken = await response.json() as { refusal?: string };
      if (taken.refusal) setError(taken.refusal);
      else setSent(result === "answered" ? `You answered: ${text}` : `You declined: ${text}`);
    } catch (answerError) {
      setError(userErrorMessage(answerError, "Couldn't send your answer"));
    } finally {
      setBusy(false);
    }
  }

  const decline = (
    <button
      type="button"
      disabled={busy}
      onClick={() => void send("refused", words.trim() || "Declined")}
      className={actionClass({ variant: "quiet", size: "sm" })}
    >
      <X className="size-3.5" />
      Decline
    </button>
  );

  return (
    <AskCard
      who="A program"
      kind={request.about ?? undefined}
      icon={<MessageCircleQuestion className="size-3.5" />}
      open={open}
      question={request.text}
      detail={<>
        {request.context && <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{request.context}</div>}
        {request.by && !outcome && <div>Closes {new Date(request.by).toLocaleString()}. Without an answer by then it counts as no reply.</div>}
      </>}
      status={outcome ? { tone: "settled", label: outcome }
        : sent ? { tone: "settled", label: sent }
        : !isHolder && { tone: "secondary", label: `Waiting for ${request.holder}` }}
    >
      <AskError error={error} loadError={null} action="Couldn't send your answer" onRetry={() => setError(null)} />
      {open && (
        <div className="mt-3 flex flex-col gap-2">
          {choices.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {choices.map((choice, index) => (
                <button
                  key={choice}
                  type="button"
                  disabled={busy}
                  aria-pressed={takesWords(choice) ? picked === choice : undefined}
                  // An option that takes words opens the field to be completed; a plain one is the answer.
                  onClick={() => (takesWords(choice) ? pick(choice) : void send("answered", choice))}
                  className={actionClass({ variant: index === 0 || picked === choice ? "primary" : "secondary", size: "sm" })}
                >
                  {choice}
                </button>
              ))}
              {!writing && decline}
            </div>
          )}
          {writing && (
            <div className="app-ask-answer">
              <textarea
                ref={field}
                value={words}
                disabled={busy}
                rows={2}
                onChange={(event) => setWords(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && words.trim()) {
                    event.preventDefault();
                    void send("answered", words.trim());
                  }
                }}
                placeholder={picked ? "Complete the option you picked" : "Your answer"}
                aria-label="Your answer"
                className="block max-h-60 min-h-[3.25rem] w-full min-w-0 resize-none px-3 pt-2.5 pb-1 text-sm leading-relaxed field-sizing-content placeholder:text-muted-foreground"
              />
              <div className="flex items-center justify-end gap-1.5 px-2 pb-2">
                {decline}
                <button
                  type="button"
                  disabled={busy || !words.trim()}
                  onClick={() => void send("answered", words.trim())}
                  className={actionClass({ variant: "primary", size: "sm" })}
                >
                  {busy ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                  Send
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </AskCard>
  );
}
