# Jev evaluation

## Diagnose a Channel summon

Run `xmatrix diagnose <channel-id> --message <message-id> --json` to inspect a
specific `@auto` or harness summon. A summon that names `repo:` is offered
that repository as written: no repository catalog is read and no repository
authorization is checked before launch. Whether the repository can be cloned is
decided by the Space's GitHub installation token when the Run starts, and a
refusal there fails the Run with its own reason. A rejection beginning
`registration_environment_jev_` or `registration_parameter_jev_` names the
decision phase and an allowlisted provider or answer failure; use
`--decision-evidence` for its retained evaluation record. Neither diagnostic
prints raw provider responses or credentials.

To compare the two catalogs without launching an Agent, use
`xmatrix space launch-targets <space-id>` and
`xmatrix agent registration show --space <space-id> --owner <owner-id> --machine <machine-id> --harness <harness> --connections`.
The latter uses the existing authorized registration reader; Space admins and
the owner can inspect configuration/grant references, and the optional connector
summary contains only identity, status and revision.

The local/server-only `@xmatrix/decision-model` package provides a general Jev
evaluation entry point through Vercel AI Gateway. It accepts one shared `state`
and named Boolean, Choice or Score `questions`. Routing is one possible caller;
this package does not launch Agents, choose Machines or alter production routing.

A `summon_intent_reference`, `summon_intent_explanation` or
`summon_intent_example` rejection means Jev read the mention as naming,
explaining or quoting an Agent rather than asking one to start; its decision
record holds the `intent` answer and probabilities. The author can write
`launch:force` after the mention to skip that check.
A new conversation's mention-less first message is read the same way with the
start rubric; Jev's `conversation` answer starts nothing and records nothing
visible (see `../architecture/auto-launch-completion.md`). The same eval script carries
labeled start cases. Check the intent rubric
with `node packages/hub/scripts/summon-intent-eval.mjs --live`.

## Worker endpoint and handoff

This branch also adds `POST /api/ai/jev/evaluate` to the Hub. Send the same JSON
with an ordinary xMatrix bearer token. The Hub verifies authentication; Agent
callers additionally require a live Run and cannot use a restricted
channel-about-session. Every authenticated Human or live Agent Run can evaluate;
there is no separate account allowlist. Caller-supplied owner ids, keys, model
names and endpoints are rejected. The provider key remains deployment-owned;
unconfigured deployments return 503. Routing still rechecks current Channel
permissions and the unchanged source publication before creating work.

On 2026-09-19, the owner explicitly requested local Wrangler secret setup.
`wrangler secret bulk --name xmatrix-hub` successfully set
the provider key and a temporary account gate on the existing production
Worker. The account gate was removed at the owner's request on 2026-09-21;
any obsolete deployed binding is unused and grants or restricts nothing.
That historical setup changed secret bindings only. The endpoint subsequently
shipped in 0.16.287. Do not copy any local secret file into Git, PR descriptions
or Channel messages. Test provider credentials are provisioned separately.

The 2026-09-21 policy change removes account filtering from evaluation, Auto,
harness binding, explicit routing and startup reconciliation. Normal authenticated
access remains required, and a missing provider key still fails closed. Publish
this change through the canonical immutable release train, then record live
evaluation evidence separately from mocked provider tests. The successful live
result below was a local CLI call, not a deployed Hub call.

## Local command

Use Node.js 22 or later and install workspace dependencies with `pnpm install`. Provide `AI_GATEWAY_API_KEY`
through a secret store or your local process environment. Do not put keys in
arguments, source files, input JSON or Channel messages. The local command also
loads the optional ignored root `.env.jev.local` file; existing environment
variables take precedence. Keep that file private (mode 0600 on Unix).
A browser login alone
does not authenticate this command.

```sh
pnpm --silent jev:evaluate < docs/examples/jev-evaluation.json
```

The command reads JSON from stdin and prints `{ model, answers, usage }` as JSON.
Input is limited to 64 KiB. It uses the fixed `typesafe-ai/jev` evaluation model,
makes no automatic retries, and times out after
15 seconds. Errors exit nonzero with a fixed error code, without dumping SDK
request bodies, credentials or raw provider errors. Use `--help` without a key.
Gateway account verification, available credits and rate limits still apply.
`jev_customer_verification_required` means Vercel requires the account owner to
complete billing verification before it will serve the request, including free
models. It does not mean the API key is invalid.

Calls use the account/provider's ordinary data policy by default. Programmatic
callers can set `zeroDataRetention: true` on `createJevClient` to require ZDR.
Vercel currently requires Pro or Enterprise for that feature; Hobby returns 403.
An explicitly requested ZDR policy never silently falls back to ordinary mode.

From an Agent Run, run the command from this checkout with the secret in its
environment: `xmatrix secret exec --secret <secretRef>=AI_GATEWAY_API_KEY -- ...`.
The credential belongs only in that child process.

## Programmatic use

```js
import { createJevClient } from '@xmatrix/decision-model';

const jev = createJevClient({ apiKey: process.env.AI_GATEWAY_API_KEY });
const result = await jev.evaluate({
  state: 'The build passed.',
  questions: {
    passed: { type: 'boolean', instructions: 'Did the build pass?' },
  },
});
```

Callers can pass `{ signal }` as the second evaluate argument. The SDK validates
question schemas and returned answers. Returned probabilities are model
judgments, not permissions or proof that an action is safe. Any later dispatch
integration retains the existing server authorization and lifecycle checks.

Tests use the real SDK with a mocked HTTP transport; they do not prove live
account access. Run `pnpm --filter @xmatrix/decision-model test`. A successful
live evaluation must be recorded separately before claiming the account works.

## Live verification

On 2026-09-19, the sample command completed against `typesafe-ai/jev` on the
configured Vercel Hobby account after the owner added a payment card. It returned
`passed.probability = 0.97`, `next.choice = "review"`, and `urgency.score = 1`;
reported usage was 380 input tokens and 62 output tokens. This confirms one live
request through the CLI, not a latency, accuracy or rate-limit benchmark.
The API key stays in the ignored local environment file, outside this record.

References: [Vercel evaluation API](https://vercel.com/docs/ai-gateway/modalities/evaluation)
and [Jev model page](https://vercel.com/ai-gateway/models/jev).
