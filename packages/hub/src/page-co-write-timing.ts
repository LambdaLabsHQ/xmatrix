/** Session-clock observations, never revision times or browser paint measurements. */
export interface PageCoWriteObservation {
  event: "first_text" | "turn_end";
  outcome: "writing" | "done" | "failed" | "stalled" | "interrupted" | "disconnected";
  turn: number;
  durationMs: number;
  editToTurnMs: number | null;
  firstDeltaMs: number | null;
  firstTextMs: number | null;
  editToFirstTextMs: number | null;
  maxWriteGapMs: number | null;
  writes: number;
}

/** Constant space and at most two observations per turn, even during long streamed answers. */
export class PageCoWriteTiming {
  private readonly started = Date.now();
  private firstDelta: number | null = null;
  private firstText: number | null = null;
  private lastText: number | null = null;
  private maxGap: number | null = null;
  private writes = 0;
  private ended = false;

  constructor(
    private readonly turn: number,
    private readonly edited: number | null,
    private readonly report: (event: PageCoWriteObservation) => void,
  ) {}

  delta(): void { this.firstDelta ??= Date.now(); }

  /** Only called after a text change reached the CRDT, excluding markers, notes, blank structure and no-ops. */
  wrote(): void {
    const now = Date.now();
    const first = this.firstText === null;
    this.firstText ??= now;
    if (this.lastText !== null) this.maxGap = Math.max(this.maxGap ?? 0, now - this.lastText);
    this.lastText = now;
    this.writes++;
    if (first) this.emit("first_text", "writing");
  }

  end(outcome: PageCoWriteObservation["outcome"]): void {
    if (this.ended) return;
    this.ended = true;
    this.emit("turn_end", outcome);
  }

  private emit(event: PageCoWriteObservation["event"], outcome: PageCoWriteObservation["outcome"]): void {
    const elapsed = (at: number | null, from = this.started) => at === null ? null : Math.max(0, at - from);
    // Observability must never prevent someone writing, including when a sink throws synchronously.
    try {
      this.report({ event, outcome, turn: this.turn, durationMs: elapsed(Date.now())!,
        editToTurnMs: this.edited === null ? null : elapsed(this.started, this.edited),
        firstDeltaMs: elapsed(this.firstDelta), firstTextMs: elapsed(this.firstText),
        editToFirstTextMs: this.edited === null ? null : elapsed(this.firstText, this.edited),
        maxWriteGapMs: this.maxGap, writes: this.writes });
    } catch { /* diagnostics are best effort */ }
  }
}
