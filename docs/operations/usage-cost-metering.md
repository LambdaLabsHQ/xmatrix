# Usage cost metering

The hosted operator pays for some calls a Space causes: Jev on the operator's
Vercel AI Gateway key (`JEV_AI_GATEWAY_API_KEY`), Composio on the shared
project key (`CONNECTOR_COMPOSIO_API_KEY`, Gmail), and the X API through the
company X app. The Hub writes one Workers Analytics Engine datapoint for each
such upstream call, so Agent work and per-Space gross margin can be accounted.
The code is `packages/hub/src/usage-cost-metering.ts`.

## What is recorded

| Source | Where | Feature (`blob4`) | Action (`blob5`) / operation (`blob6`) |
| --- | --- | --- | --- |
| `jev` | Draft summon reading in the composer | `summon_intent` | `none` / model |
| `jev` | Launch choice for a message's summon (intent, workspace, fit, model) | `launch_choice` | `none` / model |
| `jev` | Any-input launch: handoff successors, system conversations | `input_launch` | `none` / model |
| `jev` | First message that summons nobody: start intent and launch choice | `start_intent` | `none` / model |
| `jev` | Message supersession judgment | `supersession` | `none` / model |
| `jev` | Attaching a new conversation to a Page | `page_attachment` | `none` / model |
| `jev` | `POST /api/ai/jev/evaluate` | `evaluate` | `none` / model |
| `composio` | Gmail actions, Connect, check, mailbox removal, disconnect | `gmail` | Hub action (`search`, `read`, `send`, `reply`, `connect`, `verify`, `mailbox_remove`, `disconnect`) / `proxy`, `connect_link`, `connected_accounts`, `account_delete` |
| `x` | X actions, Connect, check, token refresh inside them | `x` | Hub action (`post`, `quote`, `read_post`, `timeline`, `accounts`, `upload_video`, `media_status`, `connect`, `verify`) / `posts_create`, `posts_read`, `user_posts_read`, `users_me`, `media_*`, `oauth_token` |

Every Jev call is a point, including the one retry `evaluateRoutingChoices`
may make and calls that failed or timed out: a failed call may still be
billed. Tokens come from the AI Gateway's reported usage; a failed call has
none. Each Composio and X HTTP call is a point, including the provider
refusals Composio relays (`http_<status>`). Checks before a call (missing
key, an endpoint the Hub does not call) make no request and no point.

Attribution:

- A Channel's calls go to the Space the Channel is placed in. Launch calls
  take it from the placement the launch already resolved; supersession from
  its history read; nothing is looked up only to meter.
- `evaluate` uses the verified Space membership for a Human caller, or the
  live Agent Run's birth Space; its scope kind is `space`. Earlier deployment
  points used the owner user id with scope kind `user` and remain readable.
- Connect start is metered to the Space named in its URL. The callback,
  not the start, checks that the caller administers it.

## Layout `usage_cost_v1`

Dataset `xmatrix_usage_cost` (hosted test: `xmatrix_usage_cost_test`),
binding `XMATRIX_USAGE_COST_AE`. Slots are append-only; a changed meaning
is a new `blob1` version written beside the old one until readers move.

| Slot | Meaning |
| --- | --- |
| `index1` | Space id; the owner user id when the call has no Space |
| `blob1` | Layout version, `usage_cost_v1` |
| `blob2` | Source that bills the operator: `jev`, `composio`, `x` |
| `blob3` | Scope kind: `space` or `user` |
| `blob4` | Jev feature, or the connector (`gmail`, `x`) |
| `blob5` | Connector action or lifecycle step; `none` for Jev |
| `blob6` | Upstream operation; the model (`typesafe-ai/jev`) for Jev, `unknown` when it failed |
| `blob7` | Outcome: `ok`, `error`, `timeout` |
| `blob8` | Error code: an allowlisted Jev code (`jev_rate_limited`, …), `http_<status>`, `timeout`, `network`; `none` |
| `blob9` | Hub version (`CF_VERSION_METADATA`) |
| `double1` | Calls, always 1 |
| `double2` | Input tokens (Jev) |
| `double3` | Output tokens (Jev) |
| `double4` | Latency in milliseconds |

Only ids, enums and numbers are written: never prompts, message text, mail,
addresses, account ids, X post or user ids, provider responses or
credentials. Writes are synchronous `writeDataPoint` calls the runtime
buffers: no await, no database round trip, and a failed write is swallowed.
Without the binding (self-hosted deployments, tests) metering is off and the
calls behave as before.

Analytics Engine samples heavy indexes at query time; always weight sums by
`_sample_interval`. It keeps data for three months.

## Report

`packages/hub/scripts/usage-cost-report.mjs` queries the SQL API and prints,
per Space, Jev calls and tokens by feature with an estimated cost, and
Composio and X calls. The token needs Account Analytics: Read; the
`cloudflare-prod-analysis` Space secret provides it as `CLOUDFLARE_API_TOKEN`.

```sh
CLOUDFLARE_ACCOUNT_ID=<production account id> \
  xmatrix secret exec --secret cloudflare-prod-analysis -- \
  node packages/hub/scripts/usage-cost-report.mjs --since 24h
```

`--from`/`--to` (ISO 8601) set an exact window, `--space <id>` one Space,
`--json` machine-readable output. The Jev estimate uses
`--jev-input-usd-per-mtok` (default 0.042) and `--jev-output-usd-per-mtok`
(default 0). Those defaults are a third-party-reported price, not verified
against a Vercel invoice; reconcile them with the AI Gateway bill before
treating the estimate as cost. Composio and X calls are reported as counts;
price them with the current contract.

An example query, Jev tokens by Space and feature over the last day:

```sql
SELECT index1 AS space, blob4 AS feature,
  SUM(_sample_interval * double1) AS calls,
  SUM(_sample_interval * double2) AS input_tokens,
  SUM(_sample_interval * double3) AS output_tokens
FROM xmatrix_usage_cost
WHERE blob1 = 'usage_cost_v1' AND blob2 = 'jev' AND blob3 = 'space'
  AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY space, feature
ORDER BY input_tokens DESC
FORMAT JSON
```

Send it as the request body of
`POST https://api.cloudflare.com/client/v4/accounts/<account id>/analytics_engine/sql`
with `Authorization: Bearer <token>`.
