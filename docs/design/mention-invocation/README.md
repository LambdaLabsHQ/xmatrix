# Inline Agent invocation status

The invoking `@` owns its status. Each Agent in a message updates independently, with a compact status and a hover/click progress view. While startup is in progress the chip names that stage with one -ing word — Dispatching (Queuing when the machine is offline), Spawning, Connecting (Joining after relay registration), Initializing, Stopping, Creating, and Handing off when one word cannot say it — instead of the step's done label or a second "Starting" beside it. A settled chip says Started, Failed, or Stopped — whether the Agent started reasoning, not what the Run did afterwards. The popover keeps that overall answer, and its step ladder keeps the past-tense labels. The chip shows the whole `@` expression as the author wrote it, lifecycle and workspace included, wrapping rather than truncating; the address is repeated in details and message copy/export retains its original source.

These screenshots use local synthetic fixtures and the repository theme, not production data.

An authenticated pre-spawn failure produces an idempotent Channel notice even
when the Launch already marked its Run failed. A hint does not: Jev reading the
mention as not a request, or telling the author to name the machine, stays on
this card.

Invocation details and Channel notices preserve the originating startup failure,
including Git stderr such as `non-fast-forward`, with stable classification codes.
They do not replace the cause with a guessed network/permissions explanation or
retry advice. Credentials and machine-private absolute paths are redacted, control
characters stripped, and output bounded while preserving diagnostic line breaks.
Old CLIs can only report the cause they retained; new CLI releases retain Git stderr.
A later stop confirmation preserves the failed-startup outcome and describes
cleanup rather than implying an Agent successfully started and was stopped.
An accepted execution cancellation keeps its own outcome: a late failed spawn
report cannot publish a new startup-failure notice or relabel its cleanup.

- [Desktop](desktop.png)
- [Mobile](mobile.png)
- [Started once reasoning begins](working.png)
- [A started summon stays started after the turn ends](execution-finished.png)
- [Reborn and handoff](continuations.png)
- [Mobile handoff details](continuations-mobile.png)
- [Existing-instance execution on desktop](message-execution-desktop.png)
- [Existing-instance failure on mobile](message-execution-mobile.png)
- [Typed startup failure and connection retry](typed-startup-failure-mobile.png)
- [Initial input result, independent of later Run activity](initial-input-result.png)
- [Verified final reply on mobile](final-reply-mobile.png)
- [Saved-reply recovery without rerunning the input](reply-recovery-mobile.png)

Reproduce with `pnpm --filter @xmatrix/web exec playwright test e2e/mention-invocation.spec.ts --project=web --workers=1`.

Repository-backed invocation details also retain the actual checkout base branch,
full OID and confirmation timestamp in UTC after the Run finishes. Continued
repo-pool tasks show the current confirmed remote snapshot separately, with
ancestor/diverged/unknown evidence about the recorded base. Unknown evidence
is never presented as safe or as a history rewrite. Baseline facts are not
posted as routine Channel messages. A confirmed divergence produces one
continuity warning for the human and Agent, preserving the old checkout.
Optional daemon evidence is absent for older clients; no time or base is guessed.
