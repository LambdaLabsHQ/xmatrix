/**
 * An Agent reads a page through its Human owner's browser.
 *
 * The person's Chrome extension runs the app in its side panel, signed in as
 * them and connected to their relay cell. `xmatrix browse` asks the Hub
 * (`POST /api/browser/read`); the Hub hands the request to the owner's live
 * clients in that cell and holds the Agent's call open until one answers
 * (`POST /api/browser/read/:id/answer`, by the owner only) or the wait ends.
 * The side panel reads the page the conversation was started from at once;
 * another open tab only after the person allows it; it never opens a page.
 *
 * Nothing is stored: a request lives in the cell's memory for the length of
 * the Agent's call, and the page's text goes back to the Agent alone.
 */
import type { BrowserReadAnswer } from "@xmatrix/protocol";

/** How long an Agent's call waits for the browser: long enough for the person to allow another tab. */
export const BROWSER_READ_WAIT_MS = 90_000;

type Waiting = { userId: string; settle: (answer: BrowserReadAnswer | null) => void };

/** Requests waiting in one relay cell for their owner's browser, by request id. */
export class BrowserReadWaits {
  private readonly waiting = new Map<string, Waiting>();

  /** Waits for the owner's answer to `requestId`; null when the wait ends first. */
  wait(requestId: string, userId: string, waitMs: number): Promise<BrowserReadAnswer | null> {
    // A retried call takes over the earlier wait for the same request.
    this.waiting.get(requestId)?.settle(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(null), waitMs);
      const settle = (answer: BrowserReadAnswer | null) => {
        clearTimeout(timer);
        if (this.waiting.get(requestId)?.settle === settle) this.waiting.delete(requestId);
        resolve(answer);
      };
      this.waiting.set(requestId, { userId, settle });
    });
  }

  /** Settles the request with its owner's answer; false when no such request waits for this user. */
  answer(requestId: string, userId: string, answer: BrowserReadAnswer): boolean {
    const waiting = this.waiting.get(requestId);
    if (!waiting || waiting.userId !== userId) return false;
    waiting.settle(answer);
    return true;
  }
}

/** What the Agent sees: the page as text, with where it came from. */
export function browserReadText(answer: { title: string; href: string; text: string }): string {
  return `# ${answer.title || answer.href}\n${answer.href}\n\n${answer.text.trim()}\n`;
}
