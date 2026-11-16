"use client";

import { useRef, useState, type ReactNode } from "react";
import { NORN_DELEGATED_NOTE, WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { ArrowUp, Forward, Loader2, MessageCircleQuestion, Pencil, Undo2, X } from "lucide-react";

import { AskCard, AskError } from "./ask-card";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { userErrorMessage } from "@/lib/user-facing-error";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";
import { errorFromResponse } from "@/lib/query/api-client";
import { actionClass } from "@/components/ui/action-tone";
import { useNornRequest } from "./page-reference-chip";

/**
 * A request a Norn program made of a person (docs/architecture/norn-host.md).
 * The message carries what is asked and what an answer may be; only the
 * person it was delivered to sees the controls, and the Hub takes an answer
 * from nobody else. How it ended is the note the Hub records on the message.
 * They may also delegate it to someone who answers it for them (Norn spec §7);
 * while it is open they may take it back from this card.
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
  /** The Agent Instance whose program asks (`claude:2`); null when a person wrote the program. */
  asker: string | null;
  /** The answer taken when it closes unanswered, where the asker said so. */
  otherwise: string | null;
  /** Who delegated the request to this person (`@Daniel`); declining gives it back to them. */
  delegatedBy: string | null;
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
    by: text(record.by) ?? null, asker: text(record.asker) ?? null, otherwise: text(record.otherwise) ?? null,
    delegatedBy: text(record.delegatedBy) ?? null };
}

/** An option the person completes before sending: `High(say why)` takes words of their own. */
const takesWords = (option: string) => option.includes("(");

/**
 * What is asked, apart from the rest of what the program wrote: the first
 * paragraph is the question the card leads with, and what follows a blank
 * line (how to answer, what the answer is for) reads under it as text.
 */
export function nornRequestWords(text: string): { asked: string; more: string } {
  const [asked = "", ...more] = text.trim().split(/\n[ \t]*\n/u);
  return { asked: asked.trim(), more: more.join("\n\n").trim() };
}

export function NornRequestCard({ request, channelId, outcome, token, userId, render = (text) => text }: {
  request: NornRequestMetadata;
  /** Draws the program's words as the conversation draws a message's: a Page or Channel it names is a link. */
  render?: (text: string) => ReactNode;
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
  const { asked, more } = nornRequestWords(request.text);
  const pick = (choice: string) => {
    setPicked(choice);
    setWords(choice);
    requestAnimationFrame(() => field.current?.focus());
  };

  const [delegating, setDelegating] = useState(false);
  const [to, setTo] = useState("");
  const [why, setWhy] = useState("");
  const post = (url: string, body: unknown) => postNornRequest(fetch, token, url, body);

  async function send(result: "answered" | "refused", text: string) {
    setBusy(true);
    setError(null);
    try {
      const refusal = await post(WEB_PROXY_ROUTES.channel_norn_request_answer(channelId, request.ref), { outcome: result, text });
      if (refusal) setError(refusal);
      else setSent(result === "answered" ? `You answered: ${text}`
        : request.delegatedBy ? `You gave it back to ${request.delegatedBy.replace(/^@/u, "")}: ${text}` : `You declined: ${text}`);
    } catch (answerError) {
      setError(userErrorMessage(answerError, "Couldn't send your answer"));
    } finally {
      setBusy(false);
    }
  }

  async function delegate() {
    const who = to.trim().startsWith("@") ? to.trim() : `@${to.trim()}`;
    setBusy(true);
    setError(null);
    try {
      const refusal = await post(WEB_PROXY_ROUTES.channel_norn_request_delegate(channelId, request.ref),
        { to: who, ...(why.trim() ? { reason: why.trim() } : {}) });
      if (refusal) setError(refusal);
      else setSent(`${NORN_DELEGATED_NOTE}${who.slice(1)}${why.trim() ? `: ${why.trim()}` : ""}`);
    } catch (delegateError) {
      setError(userErrorMessage(delegateError, "Couldn't delegate the request"));
    } finally {
      setBusy(false);
    }
  }

  const decline = (
    <span className="flex items-center gap-1">
      {/* A request delegated to this person is theirs to answer, not to pass on again. */}
      {!request.delegatedBy && (
        <button
          type="button"
          disabled={busy}
          aria-expanded={delegating}
          onClick={() => setDelegating((shown) => !shown)}
          className={actionClass({ variant: "quiet", size: "sm" })}
        >
          <Forward className="size-3.5" />
          Delegate…
        </button>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void send("refused", words.trim() || (request.delegatedBy ? "Given back" : "Declined"))}
        className={actionClass({ variant: "quiet", size: "sm" })}
      >
        <X className="size-3.5" />
        {request.delegatedBy ? "Give back" : "Decline"}
      </button>
    </span>
  );
  // Whoever delegated the request from this card may take it back while it is open.
  const delegatedAway = isHolder && (outcome ?? sent)?.startsWith(NORN_DELEGATED_NOTE) === true;

  return (
    <AskCard
      who={request.asker ?? "A program"}
      kind={request.about ?? undefined}
      icon={<MessageCircleQuestion className="size-3.5" />}
      open={open}
      aside={open && decline}
      question={<div className="app-ask-question">{render(asked)}</div>}
      detail={<>
        {request.delegatedBy && <div>{request.delegatedBy.replace(/^@/u, "")} delegated this to you: you answer it for them.</div>}
        {more && <div className="app-ask-more">{render(more)}</div>}
        {request.context && <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{request.context}</div>}
        {request.by && !outcome && sent === null && <div>Closes {new Date(request.by).toLocaleString()}. {request.otherwise
          ? `Without an answer by then: ${request.otherwise}.` : "Without an answer by then it counts as no reply."}</div>}
      </>}
      status={outcome ? { tone: "settled", label: outcome }
        : sent ? { tone: "settled", label: sent }
        : !isHolder ? { tone: "secondary", label: `Waiting for ${request.holder}` }
        // Buttons say an answer is wanted; a line to write on has to be told.
        : choices.length === 0 && { tone: "attention", label: "Waiting for your answer" }}
    >
      <AskError error={error} loadError={null} action="Couldn't send your answer" onRetry={() => setError(null)} />
      {delegatedAway && <TakeBack requestRef={request.ref} onTakeBack={() => post(WEB_PROXY_ROUTES.channel_norn_request_reclaim(channelId, request.ref), {})} />}
      {open && delegating && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (to.trim()) void delegate();
          }}
        >
          <input
            value={to}
            disabled={busy}
            onChange={(event) => setTo(event.target.value)}
            placeholder="@claude:2, @codex, or a person here"
            aria-label="Who answers it for you"
            autoComplete="off"
            className="h-7 min-w-36 flex-1 rounded-md border border-border bg-transparent px-2 text-sm text-foreground placeholder:text-muted-foreground"
          />
          <input
            value={why}
            disabled={busy}
            onChange={(event) => setWhy(event.target.value)}
            placeholder="Why (optional)"
            aria-label="Why it is theirs to answer"
            autoComplete="off"
            className="h-7 min-w-40 flex-[2] rounded-md border border-border bg-transparent px-2 text-sm text-foreground placeholder:text-muted-foreground"
          />
          <button type="submit" disabled={busy || !to.trim()} className={actionClass({ variant: "primary", size: "sm" })}>
            {busy ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <Forward className="size-3.5" />}
            Delegate
          </button>
        </form>
      )}
      {open && !delegating && (
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
            </div>
          )}
          {writing && (
            <div className="app-ask-answer flex min-w-0 items-start gap-3">
              <span className="app-tool-state-icon mt-[3px]" data-state={words.trim() ? "running" : "attention"} aria-hidden="true">
                <Pencil className="size-4" />
              </span>
              <textarea
                ref={field}
                value={words}
                disabled={busy}
                rows={1}
                onChange={(event) => setWords(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && words.trim()) {
                    event.preventDefault();
                    void send("answered", words.trim());
                  }
                }}
                placeholder={picked ? "Complete the option you picked" : "Write your answer here…"}
                aria-label="Your answer"
                className="block max-h-60 min-h-0 min-w-0 flex-1 resize-none p-0 py-[3px] text-sm leading-relaxed field-sizing-content"
              />
              <button
                type="button"
                title="Send"
                aria-label="Send"
                disabled={busy || !words.trim()}
                onClick={() => void send("answered", words.trim())}
                className={actionClass({ variant: "primary", size: "icon-sm" }, "rounded-full")}
              >
                {busy ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <ArrowUp className="size-4" />}
              </button>
            </div>
          )}
        </div>
      )}
    </AskCard>
  );
}

/** Posts to one of a request's routes; the Hub's refusal, if it gave one. */
async function postNornRequest(fetch: typeof globalThis.fetch, token: string | null | undefined, url: string, body: unknown): Promise<string | undefined> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await errorFromResponse(response);
  return (await response.json() as { refusal?: string }).refusal;
}

/**
 * Taking a delegated request back, offered while the Hub says the reader
 * delegated it and it is still open. It comes to them again as a new card.
 */
function TakeBack({ requestRef, onTakeBack }: { requestRef: string; onTakeBack: () => Promise<string | undefined> }) {
  const { found } = useNornRequest(requestRef);
  const [state, setState] = useState<{ busy?: boolean; done?: boolean; error?: string }>({});
  if (state.done) return <div className="mt-2 text-[13px] text-muted-foreground">You took it back: it comes to you again here.</div>;
  if (!found?.yoursToTakeBack) return null;
  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        type="button"
        disabled={state.busy}
        onClick={() => {
          setState({ busy: true });
          void onTakeBack().then((refusal) => setState(refusal ? { error: refusal } : { done: true }),
            (takeBackError: unknown) => setState({ error: userErrorMessage(takeBackError, "Couldn't take the request back") ?? "Couldn't take the request back" }));
        }}
        className={actionClass({ variant: "secondary", size: "sm" })}
      >
        {state.busy ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}
        Take back
      </button>
      {state.error && <span className="text-[13px] text-destructive">{state.error}</span>}
    </div>
  );
}
