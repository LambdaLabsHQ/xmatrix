# Harness questions

An Agent's harness can stop and ask its person to choose. xMatrix defines no
question tool of its own: the Run parks the harness's native request, posts it
to the turn's Channel as a questionnaire card, and answers that same request
with what the person picked, so the harness continues the turn it is in.

## Native requests

| Harness | How it asks | What makes it ask | Answer |
| --- | --- | --- | --- |
| Claude Code | `control_request` `can_use_tool` for `AskUserQuestion` | `--permission-prompt-tool stdio` (headless Claude withholds the tool without it) | `allow` with `updatedInput.answers` keyed by question text |
| Codex | server request `item/tool/requestUserInput` | `-c features.default_mode_request_user_input=true` (otherwise Plan mode only) | `{ answers: { <questionId>: { answers: [...] } } }` |
| ACP agents (Grok, Kimi, Cursor, Gemini, …) | server request `elicitation/create`, form mode | `clientCapabilities.elicitation.form` in `initialize` | `{ action: "accept", content }` typed by the requested schema |
| ZCode | none yet | — | — |

With `--dangerously-skip-permissions` Claude sends `can_use_tool` only for
tools that need a person; every other tool is allowed with its input
unchanged, so the permission prompt tool changes nothing else.

Secrets are never relayed: a Codex question marked `isSecret` is answered
empty, and ACP URL-mode elicitations are cancelled.

## Card and answer

The card is a Channel message with metadata `xmatrix.questionnaire.v1`
(`harness`, `requestKey`, and per question `id`, `label`, `header`,
`selectionMode`, `allowOther`, `options`). The Web answers with a reply whose
metadata is `xmatrix.questionnaire_answer.v1` (`questionnaireMessageId`,
`requestKey`, `answers` as option labels or typed text per question id). A
card is shown answered once such a reply is in the timeline.

During the turn the Run takes that reply out of delivery: it answers the
parked request, acknowledges the message, and does not interrupt the turn. A
message the person types instead interrupts as usual, and the Run first
cancels the parked requests so the harness never waits on a card. A card
answered after its turn ended reaches the Agent as an ordinary reply.

Code: `packages/cli-rs/crates/runtime/src/runtime_harness_questions.rs`
(mapping and parking) and `apps/web/src/components/dashboard/questionnaire-card.tsx`.
