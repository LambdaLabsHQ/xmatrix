# Codex model capacity recovery

The Codex runtime retries `Selected model is at capacity.` failures up to three
additional times on the same thread and model, after 5, 15 and 30 seconds plus
up to 1.02 seconds of jitter. The failed turn's input and attachments remain in
that thread; retries send a continuation instruction instead of replaying them.
Model, effort, selected parameters and developer instructions stay in force.

Recovery requires a matching `turn/completed` receipt with status `failed` and
no observed execution or assistant output. An error notification alone is not
permission to launch another turn. The adapter waits at most ten seconds for
its terminal receipt; a missing receipt ends the wrapper turn and requires
provider restart. Tool activity or output prevents automatic replay. Quota,
authentication and other failures keep their existing handling. When Codex
reports `willRetry: true`, it owns recovery and xMatrix keeps reading that turn.
A failed or interrupted terminal receipt is never reported as success.

The retry budget belongs to one interruptible wrapper turn. New live input,
model/effort switches and shutdown cancel its backoff through the existing
control path. Intermediate attempts appear in runtime traces (the shared `runtime_event` retrying status);
the Channel failure notice is emitted only if the wrapper exhausts recovery.
The updated CLI is required; an already running Agent wrapper uses its original
binary until reborn.

The owning stdio adapter tests in `tests_codex_capacity_retry.rs` protect recovery,
settings and input preservation, exhaustion, execution refusal, native recovery,
missing receipts and interruption. These cases previously ended at the first
capacity notification or treated failed terminal receipts as success.

The [OpenAI app-server contract](https://developers.openai.com/codex/app-server)
defines terminal failed turns and their errors. The
[OpenAI error guidance](https://developers.openai.com/api/docs/guides/error-codes)
recommends delayed retries for temporary model overload; this policy deliberately
classifies only the capacity message observed by xMatrix rather than broadening
all transport or quota errors.
