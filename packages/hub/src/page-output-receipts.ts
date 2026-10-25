import { PAGE_CO_WRITE_RATE, parsePageCoWriteReply, sha256Hex, type PageCoWriteReply, type PageCoWriteRequest } from "@xmatrix/protocol";

/** Internal Page-domain transport. The authenticated router supplies the scope and expiry. */
export interface PageOutputWrite {
  stream: string;
  expiresAt: number;
  seq: number;
  session?: string;
  reply: PageCoWriteReply | { type: "answer"; turn: number } | { type: "cancel"; turn: number };
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
  binding?: string;
  cancelled?: boolean;
}

export const PAGE_OUTPUT_LIFETIME_MS = 30 * 60_000;
const MAX_STREAMS = 128;

export function parsePageOutputWrite(value: unknown): PageOutputWrite | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.stream !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/u.test(input.stream) ||
      typeof input.seq !== "number" || !Number.isSafeInteger(input.seq) || input.seq < 0 ||
      typeof input.expiresAt !== "number" || !Number.isSafeInteger(input.expiresAt)) return null;
  const raw = input.reply as Record<string, unknown> | null;
  const session = input.session;
  if (session !== undefined && (typeof session !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/u.test(session))) return null;
  const base = { stream: input.stream, expiresAt: input.expiresAt, seq: input.seq,
    ...(typeof session === "string" ? { session } : {}) };
  if (raw && (raw.type === "answer" || raw.type === "cancel")) {
    if (typeof raw.turn !== "number" || !Number.isSafeInteger(raw.turn) || raw.turn < 0 ||
        (raw.type === "answer" && !session)) return null;
    return { ...base, reply: { type: raw.type, turn: raw.turn } };
  }
  const reply = parsePageCoWriteReply(raw);
  if (!reply || reply.turn < 0 || (session && reply.type === "write") || (reply.type !== "write" && !reply.paced) ||
      (reply.type === "write" && reply.atOnce) ||
      (reply.type === "delta" && [...reply.text].length > PAGE_CO_WRITE_RATE.chunkChars)) return null;
  return { ...base, reply };
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
    const binding = JSON.stringify([write.session ?? null, write.reply.turn]);
    const digest = await sha256Hex(JSON.stringify(write.reply));
    const previous = this.receipts.get(key);
    // Cancellation is a durable fence even if the preceding RPC is still in
    // flight. The Page stops only the bound writer, never a replacement turn.
    const cancelling = write.reply.type === "cancel";
    if (previous) {
      if (previous.expiresAt !== write.expiresAt || (previous.binding && previous.binding !== binding)) {
        return { status: "rejected", seq: write.seq };
      }
      if (previous.cancelled && !cancelling) return { status: "rejected", seq: write.seq };
      if (!cancelling) {
        if (previous.seq === write.seq) {
          if (previous.digest !== digest) return { status: "rejected", seq: write.seq };
          if (previous.receipt.status !== "limited") return previous.receipt;
        } else if (previous.seq + 1 !== write.seq || previous.receipt.status !== "accepted") {
          return { status: "out_of_order", seq: previous.seq };
        }
        if (!this.live.has(key)) return { status: "unknown", seq: write.seq };
      }
    } else if (this.receipts.size >= MAX_STREAMS || (!cancelling &&
        (write.seq !== 0 || (write.reply.type !== "write" && write.reply.type !== "answer")))) {
      return { status: "rejected", seq: write.seq };
    }
    const intent: StoredPageOutputReceipt = { key, expiresAt: write.expiresAt, seq: write.seq, digest, binding,
      ...(cancelling ? { cancelled: true } : {}),
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
