import { PAGE_CO_WRITE_RATE, parsePageCoWriteReply, sha256Hex, type PageCoWriteReply, type PageCoWriteRequest } from "@xmatrix/protocol";

/** Internal Page-domain transport. The authenticated router supplies the scope and expiry. */
export interface PageOutputWrite {
  stream: string;
  expiresAt: number;
  seq: number;
  reply: PageCoWriteReply;
}

export type PageOutputReceipt =
  | { status: "accepted"; seq: number; notices: PageCoWriteRequest[] }
  | { status: "limited"; seq: number; at: number; retryAfterMs: number }
  | { status: "unknown" | "rejected" | "out_of_order"; seq: number };

export interface StoredPageOutputReceipt {
  key: string;
  expiresAt: number;
  seq: number;
  digest: string;
  receipt: PageOutputReceipt;
}

export const PAGE_OUTPUT_LIFETIME_MS = 30 * 60_000;
const MAX_STREAMS = 128;

export function parsePageOutputWrite(value: unknown): PageOutputWrite | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.stream !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/u.test(input.stream) ||
      typeof input.seq !== "number" || !Number.isSafeInteger(input.seq) || input.seq < 0 ||
      typeof input.expiresAt !== "number" || !Number.isSafeInteger(input.expiresAt)) return null;
  const reply = parsePageCoWriteReply(input.reply);
  if (!reply || reply.turn < 0 || (reply.type !== "write" && !reply.paced) ||
      (reply.type === "write" && reply.atOnce) ||
      (reply.type === "delta" && [...reply.text].length > PAGE_CO_WRITE_RATE.chunkChars)) return null;
  return { stream: input.stream, expiresAt: input.expiresAt, seq: input.seq, reply };
}

/**
 * Receipts are persisted with the document. An intent is saved before touching
 * it, so losing an acknowledgement cannot cause a second application. The live
 * writer's relative anchors are deliberately not reconstructed from a receipt:
 * after state loss a new chunk is unknown, never an instruction to start over.
 */
export class PageOutputReceipts {
  private readonly receipts = new Map<string, StoredPageOutputReceipt>();
  private readonly live = new Set<string>();

  restore(records: readonly StoredPageOutputReceipt[]): void {
    for (const record of records) if (record.expiresAt > Date.now()) this.receipts.set(record.key, record);
  }

  snapshot(): StoredPageOutputReceipt[] { return [...this.receipts.values()]; }

  async receive(key: string, write: PageOutputWrite, ports: {
    persist(): Promise<void>;
    apply(first: boolean): PageCoWriteRequest[];
  }): Promise<PageOutputReceipt> {
    const now = Date.now();
    if (!Number.isSafeInteger(write.seq) || write.seq < 0 || !Number.isSafeInteger(write.expiresAt) ||
        write.expiresAt <= now || write.expiresAt > now + PAGE_OUTPUT_LIFETIME_MS) {
      return { status: "rejected", seq: write.seq };
    }
    for (const [id, record] of this.receipts) if (record.expiresAt <= now) {
      this.receipts.delete(id);
      this.live.delete(id);
    }
    const digest = await sha256Hex(JSON.stringify(write.reply));
    const previous = this.receipts.get(key);
    if (previous) {
      if (previous.expiresAt !== write.expiresAt) return { status: "rejected", seq: write.seq };
      if (previous.seq === write.seq) {
        if (previous.digest !== digest) return { status: "rejected", seq: write.seq };
        if (previous.receipt.status !== "limited") return previous.receipt;
      } else if (previous.seq + 1 !== write.seq || previous.receipt.status !== "accepted") {
        return { status: "out_of_order", seq: previous.seq };
      }
      if (!this.live.has(key)) return { status: "unknown", seq: write.seq };
    } else if (write.seq !== 0 || this.receipts.size >= MAX_STREAMS || write.reply.type !== "write") {
      return { status: "rejected", seq: write.seq };
    }
    const intent: StoredPageOutputReceipt = { key, expiresAt: write.expiresAt, seq: write.seq, digest,
      receipt: { status: "unknown", seq: write.seq } };
    this.receipts.set(key, intent);
    // If either persistence fails, the intent remains unknown even in this process.
    this.live.delete(key);
    await ports.persist();
    const notices = ports.apply(!previous);
    const limited = notices.find((notice) => notice.type === "limited");
    const receipt: PageOutputReceipt = limited?.type === "limited"
      ? { status: "limited", seq: write.seq, at: limited.at, retryAfterMs: limited.retryAfterMs }
      : { status: "accepted", seq: write.seq, notices };
    this.receipts.set(key, { ...intent, receipt });
    try { await ports.persist(); }
    catch (error) { this.receipts.set(key, intent); throw error; }
    this.live.add(key);
    return receipt;
  }
}
