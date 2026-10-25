import { sha256Hex, type PageAssistantOutput, type PageAssistantOutputAck, type PageAssistantOutputTarget } from "@xmatrix/protocol";
export { parsePageAssistantOutput } from "@xmatrix/protocol";
import type { PageCoWriteRequest } from "@xmatrix/protocol";
import { emptyPageOutputParser, finishPageOutput, takePageOutput, type PageOutputParserState } from "./page-output-parser";
import { PAGE_OUTPUT_LIFETIME_MS, type PageOutputReceipt, type PageOutputWrite } from "./page-output-receipts";

export const PAGE_ASSISTANT_OUTPUT_PATH = "/internal/page-assistant-output";
interface Target { page: string; stream: string; seq: number; at: number }
interface State {
  startedAt: number;
  expiresAt: number;
  seq: number;
  digest: string;
  at: number;
  parser: PageOutputParserState;
  target: Target | null;
  spans: number;
  ended: boolean;
  unknown: boolean;
  ack: PageAssistantOutputAck | null;
  problems: string[];
  binding?: PageAssistantOutputTarget;
  cancelPending?: { page: string; write: PageOutputWrite };
  /** One bounded Page operation, kept across an ambiguous RPC result. */
  pending: { page: string; write: PageOutputWrite; next: PageOutputParserState; consumed: number;
    target: Target | null; spans: number } | null;
}

function planOutput(state: State, input: PageAssistantOutput, chars: string[]): ReturnType<typeof takePageOutput> {
  if (!state.binding) return input.type === "text"
    ? takePageOutput(state.parser, chars, state.at) : finishPageOutput(state.parser);
  if (state.spans === 0) return { state: { page: state.binding.page, held: "" }, consumed: 0,
    action: { type: "open", page: state.binding.page } };
  if (input.type === "end" && state.target) return { state: emptyPageOutputParser(), consumed: 0, action: { type: "close" } };
  const text = chars.slice(state.at, state.at + 10).join("");
  return { state: state.parser, consumed: [...text].length, action: text ? { type: "text", text } : null };
}

export interface PageAssistantOutputPorts {
  load(key: string): Promise<State | undefined>;
  save(key: string, state: State): Promise<void>;
  /** Admission is bounded; retired records are removed only after their input's expiry. */
  admit(prefix: string, now: number): Promise<boolean>;
  write(page: string, write: PageOutputWrite): Promise<PageOutputReceipt>;
}

/** A Run-scoped delivery interpreter. The Page session owns permissions and document effects. */
export class PageAssistantOutputReceiver {
  private readonly queues = new Map<string, Promise<unknown>>();

  receive(scope: string, input: PageAssistantOutput, ports: PageAssistantOutputPorts): Promise<PageAssistantOutputAck> {
    const key = `page-output:${scope}:${input.stream}`;
    const previous = this.queues.get(scope) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(() => this.apply(key, scope, input, ports));
    this.queues.set(scope, work);
    void work.finally(() => { if (this.queues.get(scope) === work) this.queues.delete(scope); }).catch(() => {});
    return work;
  }

  private async apply(key: string, scope: string, input: PageAssistantOutput, ports: PageAssistantOutputPorts): Promise<PageAssistantOutputAck> {
    const ack = (status: PageAssistantOutputAck["status"], at = 0, problems: string[] = []): PageAssistantOutputAck =>
      ({ stream: input.stream, seq: input.seq, at, status, problems });
    const now = Date.now();
    if (input.startedAt > now + 60_000 || input.startedAt + PAGE_OUTPUT_LIFETIME_MS <= now) {
      return ack("rejected", 0, ["The assistant output stream expired; read the page before writing again."]);
    }
    const digest = await sha256Hex(JSON.stringify(input.target
      ? [input.type, input.text, input.target] : [input.type, input.text]));
    let state = await ports.load(key);
    // Cancellation fences every later delivery, including an in-flight Page
    // RPC whose acknowledgement was lost. It never retries a model turn.
    if (input.type === "cancel") {
      if (state && (state.startedAt !== input.startedAt || JSON.stringify(state.binding) !== JSON.stringify(input.target))) {
        return ack("rejected");
      }
      if (!state && !await ports.admit(`page-output:${scope}:`, now)) return ack("rejected");
      const expiresAt = state?.expiresAt ?? Math.min(input.startedAt, now) + PAGE_OUTPUT_LIFETIME_MS;
      let cancelPending = state?.cancelPending;
      if (!cancelPending) {
        const target = state?.pending ? { page: state.pending.page, stream: state.pending.write.stream,
          seq: state.pending.write.seq } : state?.target ?? (input.target
          ? { page: input.target.page, stream: `${input.stream}_1`, seq: 0 } : null);
        if (target) cancelPending = { page: target.page,
          write: { stream: target.stream, expiresAt, seq: target.seq, ...(input.target ? { session: input.target.session } : {}),
            reply: { type: "cancel", turn: input.target?.turn ?? 1 } } };
      }
      state = { startedAt: input.startedAt, expiresAt, binding: input.target,
        seq: input.seq, digest, at: 0, parser: emptyPageOutputParser(), target: null, cancelPending,
        spans: state?.spans ?? 0, ended: true, unknown: true, pending: null, ack: null, problems: [] };
      await ports.save(key, state);
      if (cancelPending) {
        const receipt = await ports.write(cancelPending.page, cancelPending.write);
        if (receipt.status !== "accepted" || receipt.seq !== cancelPending.write.seq) {
          return ack("unknown", 0, ["Page cancellation could not be confirmed; read the current page before continuing."]);
        }
        state.cancelPending = undefined;
      }
      state.ack = ack("accepted");
      await ports.save(key, state);
      return ack("accepted");
    }
    if (!state) {
      if (input.seq !== 0 || !await ports.admit(`page-output:${scope}:`, now)) return ack("rejected");
      state = { startedAt: input.startedAt, expiresAt: Math.min(input.startedAt, now) + PAGE_OUTPUT_LIFETIME_MS,
        seq: 0, digest, at: 0, parser: emptyPageOutputParser(), target: null,
        spans: 0, ended: false, unknown: false, pending: null, ack: null, problems: [], binding: input.target };
    } else {
      if (state.startedAt !== input.startedAt || JSON.stringify(state.binding) !== JSON.stringify(input.target)) return ack("rejected");
      if (state.unknown) return ack("unknown", state.seq === input.seq ? state.at : 0,
        ["Page output could not be confirmed; read the page before continuing."]);
      if (state.seq === input.seq) {
        if (state.digest !== digest) return ack("rejected", state.at);
        if (state.ack?.status === "accepted") return state.ack;
      } else {
        if (state.ended || input.seq !== state.seq + 1 || state.ack?.status !== "accepted") return ack("rejected", state.at);
        state = { ...state, seq: input.seq, digest, at: 0, ack: null, problems: [] };
      }
    }
    const chars = [...(input.text ?? "")];
    const problems = state.problems;
    // Bound work per request even when ordinary text opens many different pages.
    for (let operations = 0; operations < 32; operations++) {
      if (!state.pending) {
        const plan = planOutput(state, input, chars);
        const action = plan.action;
        if (!action) {
          state.parser = plan.state;
          state.at += plan.consumed;
          break;
        }
        let target = state.target ? { ...state.target } : null;
        let spans = state.spans;
        let write: PageOutputWrite;
        const expiresAt = state.expiresAt;
        if (action.type === "open") {
          spans++;
          target = { page: action.page, stream: `${input.stream}_${spans}`, seq: 0, at: 0 };
          write = { stream: target.stream, expiresAt, seq: 0,
            reply: { type: state.binding ? "answer" : "write", turn: state.binding?.turn ?? 1 } };
        } else {
          if (!target) return ack("unknown", state.at, ["The page output target was lost."]);
          write = { stream: target.stream, expiresAt, seq: target.seq,
            reply: action.type === "text" ? { type: "delta", turn: state.binding?.turn ?? 1, text: action.text, paced: { at: target.at } }
              : { type: "done", turn: state.binding?.turn ?? 1, paced: { at: target.at } } };
        }
        if (state.binding) write.session = state.binding.session;
        const page = target.page;
        target.seq++;
        if (action.type === "text") target.at += [...action.text].length;
        if (action.type === "close") target = null;
        state.pending = { page, write, next: plan.state, consumed: plan.consumed, target, spans };
        // This exact operation is retried after an ambiguous network failure.
        await ports.save(key, state);
      }
      const pending = state.pending;
      const receipt = await ports.write(pending.page, pending.write);
      const expectedAt = "paced" in pending.write.reply ? pending.write.reply.paced?.at : 0;
      if (receipt.seq !== pending.write.seq || (receipt.status === "limited" && receipt.at !== expectedAt)) {
        state.unknown = true;
        await ports.save(key, state);
        return ack("unknown", state.at, ["The Page output receipt did not match the pending write."]);
      }
      if (receipt.status === "limited") {
        const response = { ...ack("limited", state.at, problems), retryAfterMs: receipt.retryAfterMs };
        state.ack = response;
        await ports.save(key, state);
        return response;
      }
      if (receipt.status !== "accepted") {
        state.unknown = true;
        await ports.save(key, state);
        return ack("unknown", state.at, ["The Page session could not confirm this output. Read the current page before continuing."]);
      }
      const notices: PageCoWriteRequest[] = receipt.notices;
      for (const notice of notices) if (notice.type === "outcome") problems.push(...notice.problems.slice(0, 32 - problems.length));
      state.parser = pending.next;
      state.at += pending.consumed;
      state.target = pending.target;
      state.spans = pending.spans;
      state.pending = null;
      if (notices.some((notice) => notice.type === "interrupt")) {
        state.unknown = true;
        await ports.save(key, state);
        return ack("rejected", state.at, [...problems, "The Page stopped this write; read its current text before continuing."]);
      }
      await ports.save(key, state);
    }
    const complete = input.type === "text" ? state.at === chars.length : !state.parser.page;
    const response = { ...ack(complete ? "accepted" : "limited", state.at, problems), ...(!complete ? { retryAfterMs: 0 } : {}) };
    state.ended = input.type === "end" && complete;
    state.ack = response;
    await ports.save(key, state);
    return response;
  }
}
