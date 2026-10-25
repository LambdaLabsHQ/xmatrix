/**
 * Live co-writing (docs/design/pages-live-document.md §4.2): an Agent writes
 * into a page as its words come, like a person beside you in a shared
 * document. Its harness answers in ordinary text; the runtime streams that
 * text to the page's live session as it is generated, and only what stands
 * inside these markers reaches the page:
 *
 *   ⟦after "words on the page"⟧ markdown added after the block holding them
 *   ⟦replace "words on the page"⟧ the new wording of exactly those words
 *   ⟦note "words on the page"⟧ a remark to the people about those words
 *   ⟦pass⟧ nothing to add now
 *
 * Every harness can write text, so every Agent can co-write: no tool call is
 * needed, and a tool call could not stream.
 */

/** A frame on a page session's WebSocket carrying co-writing JSON (after sync 0, awareness 1, notice 2). */
export const PAGE_MESSAGE_CO_WRITE = 3;

/**
 * What an Agent wrote stays marked in its colour this long, as a highlighter marks it: for whoever is on
 * the page while it writes, and whoever opens the page meanwhile. A reader who looks away, or comes later,
 * still sees which paragraphs each Agent wrote.
 */
export const PAGE_AGENT_INK_MS = 5 * 60_000;

/**
 * How fast a page's session takes the words an Agent writes into it live (pages-live-document.md §4.2),
 * counted in characters (code points) of what the runtime sends. A runtime sends at most `chunkChars` at a
 * time, `charsPerSecond` on average; the session refuses a write past its own allowance (`limited`) and
 * takes nothing of it, so the page only ever holds what the Agent was allowed to send. The session's
 * allowance holds `burstChars`, more than one chunk, so the network's jitter between two chunks sent in
 * time is never refused.
 */
export const PAGE_CO_WRITE_RATE = { chunkChars: 10, charsPerSecond: 20, burstChars: 20 } as const;

const PAGE_CO_WRITE_OPEN = "⟦";
const PAGE_CO_WRITE_CLOSE = "⟧";

export type PageCoWriteAction = "after" | "replace" | "note";

export type PageCoWriteEvent =
  | { type: "start"; action: PageCoWriteAction; quote: string }
  | { type: "text"; text: string }
  | { type: "end" }
  | { type: "pass" };

/**
 * The live session asks; the runtime hands it to the Agent's harness as its next input. A turn the
 * runtime opened itself (`write`) is answered with its `outcome` when it ends: what did not reach the
 * page and why, so the Agent hears it; nothing when all of it did.
 */
export type PageCoWriteRequest =
  | { type: "turn"; turn: number; text: string }
  | { type: "interrupt"; turn: number }
  | { type: "outcome"; turn: number; problems: string[] }
  /**
   * A paced write the session refused, as an HTTP 429 refuses: nothing of it was taken. The runtime sends
   * the turn's words again from character `at` (what the session has taken of the turn) once
   * `retryAfterMs` has passed.
   */
  | { type: "limited"; turn: number; at: number; retryAfterMs: number };

/**
 * The runtime answers with the harness's text as it comes, and when the harness's turn ends. A runtime
 * streaming what its Agent writes from a conversation (`⟦write page:<id>⟧ … ⟦/write⟧` in its reply) opens
 * the turn itself, with `write`: nobody asked it.
 */
export type PageCoWriteReply =
  /** `atOnce`: written as it comes, whoever reads the page (a message's write, which its sender waits on). */
  | { type: "write"; turn: number; atOnce?: boolean }
  /**
   * `paced`: the runtime keeps to `PAGE_CO_WRITE_RATE`, `at` is where `text` starts among the characters
   * it sent for the turn, and the session refuses what goes past its allowance or does not follow on.
   */
  | { type: "delta"; turn: number; text: string; paced?: { at: number } }
  /** `paced`: how many characters the runtime sent for the turn; the session takes the end only once it has them all. */
  | { type: "done"; turn: number; paced?: { at: number } }
  | { type: "failed"; turn: number; reason?: string; paced?: { at: number } };

/** A marker longer than this is text that happens to hold the opening bracket. */
const HEADER_MAX = 1_000;
const HEADER = /^\s*(after|replace|note|pass|end)(?:\s+([\s\S]*?))?\s*$/u;
const QUOTES: ReadonlyArray<readonly [string, string]> = [['"', '"'], ["“", "”"], ["'", "'"],
  ["‘", "’"], ["「", "」"], ["『", "』"], ["`", "`"]];

function unquote(text: string): string {
  const value = text.trim();
  for (const [open, close] of QUOTES) {
    if (value.length >= 2 && value.startsWith(open) && value.endsWith(close)) return value.slice(open.length, -close.length);
  }
  return value;
}

function header(text: string): { action: PageCoWriteAction | "pass" | "end"; quote: string } | null {
  const match = HEADER.exec(text);
  if (!match) return null;
  const action = match[1] as PageCoWriteAction | "pass" | "end";
  const quote = unquote(match[2] ?? "");
  if ((action === "after" || action === "replace" || action === "note") && !quote) return null;
  return { action, quote };
}

/**
 * Reads an Agent's answer as it streams. Text arrives in pieces cut anywhere,
 * a marker included; a marker is acted on once it is whole, and the text after
 * it is passed on as it comes. Text outside an action, and markers it does not
 * know, never reach the page.
 */
export class PageCoWriteParser {
  private buffer = "";
  private open = false;
  /** The newline that ends a marker's own line is not part of what follows it. */
  private fresh = false;

  push(text: string): PageCoWriteEvent[] {
    this.buffer += text;
    return this.drain(false);
  }

  /** The answer ended: what is left is text, and an open action closes. */
  finish(): PageCoWriteEvent[] {
    const events = this.drain(true);
    if (this.open) events.push({ type: "end" });
    this.open = false;
    this.buffer = "";
    return events;
  }

  private text(events: PageCoWriteEvent[], text: string): void {
    if (!this.open || !text) return;
    if (this.fresh) {
      text = text.replace(/^[ \t]*\r?\n/u, "");
      if (!text) return;
      this.fresh = false;
    }
    events.push({ type: "text", text });
  }

  private drain(final: boolean): PageCoWriteEvent[] {
    const events: PageCoWriteEvent[] = [];
    for (;;) {
      const at = this.buffer.indexOf(PAGE_CO_WRITE_OPEN);
      if (at < 0) {
        // A marker's line may end in the next piece: hold back a lone trailing space or tab after it.
        if (this.fresh && !final && /^[ \t]*$/u.test(this.buffer)) return events;
        this.text(events, this.buffer);
        this.buffer = "";
        return events;
      }
      if (at > 0) {
        this.text(events, this.buffer.slice(0, at));
        this.buffer = this.buffer.slice(at);
      }
      const close = this.buffer.indexOf(PAGE_CO_WRITE_CLOSE);
      if (close < 0 && !final && this.buffer.length <= HEADER_MAX) return events;
      const marker = close < 0 ? null : header(this.buffer.slice(1, close));
      if (!marker) {
        // Not a marker: a bracket that opened nothing is text, a marker it does not know is dropped.
        if (close < 0 || this.buffer.length > HEADER_MAX) {
          this.text(events, this.buffer.slice(0, 1));
          this.buffer = this.buffer.slice(1);
        } else this.buffer = this.buffer.slice(close + 1);
        continue;
      }
      this.buffer = this.buffer.slice(close + 1);
      if (this.open) events.push({ type: "end" });
      this.open = false;
      this.fresh = false;
      if (marker.action === "pass") events.push({ type: "pass" });
      else if (marker.action !== "end") {
        events.push({ type: "start", action: marker.action, quote: marker.quote });
        this.open = true;
        this.fresh = true;
      }
    }
  }
}

export function parsePageCoWriteReply(value: unknown): PageCoWriteReply | null {
  if (!value || typeof value !== "object") return null;
  const reply = value as Record<string, unknown>;
  if (typeof reply.turn !== "number" || !Number.isSafeInteger(reply.turn)) return null;
  if (reply.type === "write") return { type: "write", turn: reply.turn, ...(reply.atOnce === true ? { atOnce: true } : {}) };
  const at = (reply.paced as { at?: unknown } | undefined)?.at;
  const paced = typeof at === "number" && Number.isSafeInteger(at) && at >= 0 ? { paced: { at } } : {};
  if (reply.type === "delta" && typeof reply.text === "string") return { type: "delta", turn: reply.turn, text: reply.text, ...paced };
  if (reply.type === "done") return { type: "done", turn: reply.turn, ...paced };
  if (reply.type === "failed") {
    return { type: "failed", turn: reply.turn,
      ...(typeof reply.reason === "string" ? { reason: reply.reason.slice(0, 300) } : {}), ...paced };
  }
  return null;
}
