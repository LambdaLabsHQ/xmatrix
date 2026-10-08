# Inline Agent invocation status

The invoking `@` owns its status. Each Agent in a message updates independently, with a compact status and a hover/click progress view. While startup is in progress the chip names that stage with one -ing word — Dispatching (Queuing when the machine is offline), Spawning, Connecting (Joining after relay registration), Initializing, Stopping, Creating, and Handing off when one word cannot say it — instead of the step's done label or a second "Starting" beside it. A settled chip says Started, Failed, or Stopped — whether the Agent started reasoning, not what the Run did afterwards. The popover keeps that overall answer, and its step ladder keeps the past-tense labels. The chip shows the whole `@` expression as the author wrote it, lifecycle and workspace included, wrapping rather than truncating; the address is repeated in details and message copy/export retains its original source.

These screenshots use local synthetic fixtures and the repository theme, not production data.

The Web composer asks Jev about summon intent after a 350 ms typing pause,
using the exact outgoing body, summon ranges and the author's authorized
Channel context. Mention bands show the reading. A declined address has a clickable dotted
underline that opens xMatrix's explanation and a **Start anyway** option at
that mention. The option writes `launch:force` only on that summon; sending
still owns publication and launch. Normal summons add no explanatory text,
and no caption sits below the input. The separate intent/Force pill is removed. Enter finishes or reuses
the current bounded preview request before publishing. Any edit or Channel
change discards the old reading. Forced mentions skip preview.

A Human send carries the confirmed readings, bound to exact UTF-16 offsets and
mention text. These are the author's intent choices, like `launch:force`,
not credentials or proof of a model decision. The server accepts them only
from Human message authors and still reads the stored source, current access,
registration grants, launch fences, workspace, model and machine authority.
A confirmed non-request allocates nothing; a confirmed request skips only the
intent question and records its source as `draft`. The first four summons are
previewed. Unread summons, old clients, first messages of new Channels and
unavailable previews retain the ordinary post-send intent check. No durable
launch or Run is created by preview.

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
