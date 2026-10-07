# App Connector Operations

App connectors route app context into xMatrix channels through typed provider manifests, space-level connection records, and Hub-side executors. Connection records may store provider ids, status, scopes, enabled channel ids, configured agent ids, secret reference names, and bounded metadata only. They must not store provider tokens, webhook secrets, installation access tokens, or OAuth refresh tokens.

## Current Providers

- GitHub is available for repository-wide issue subscriptions and `subscribe`, `issue_to_channel`, and `issue_to_thread` issue/PR imports.
- Webhook is available for any system that can POST JSON. A Space admin connects it in Apps and generates an ingress URL. A channel then runs `@webhook:subscribe:<source>`, and the sender posts to `<ingress URL>?source=<source>`.

### Retrying a connection check

Apps keeps **Check** available for both Connected and Needs attention connections.
After a temporary provider failure, retry Check against the retained connection
before starting a new authorization. A successful HTTP response alone is not a
passed check: the recorded connection must return to `configured`. A failed
check stays in Needs attention and can be retried. An explicitly disconnected
connection still requires reconnection; Check does not replace consent, restore
retired grants, or allow Agent actions before the server records a passed check.

### Event Provider Setup

In Apps, connect the provider and open Credentials. Paste the provider's
secret, or copy the Hub-generated one into the provider, and point the
provider's webhook at the ingress URL. Then subscribe a channel with
`@<provider>:subscribe:<source> [features|all]`. `*` subscribes every source.

| Provider | Secret | Verification | Source |
| --- | --- | --- | --- |
| Webhook | signing secret (generated, optional) | `X-Xmatrix-Signature: sha256=` HMAC, if present | `?source=` name |
| Sentry | integration client secret | `Sentry-Hook-Signature` HMAC-SHA256 | project slug |
| Linear | webhook signing secret | `Linear-Signature` HMAC-SHA256 + 60 s freshness | team key |
| PagerDuty | v3 webhook secret | `X-PagerDuty-Signature` `v1=` HMAC-SHA256 (any of several) | service id |
| GitLab | secret token (generated) | `X-Gitlab-Token` equality | `group/project` path |
| Slack | app signing secret | `X-Slack-Signature` `v0=` HMAC over `v0:ts:body` + 5 min skew; URL handshake answered | channel id |
| Jira Cloud | webhook secret (generated) | `X-Hub-Signature: sha256=` HMAC | project key |
| Vercel | webhook secret | `x-vercel-signature` HMAC-SHA1 | project name |
| Cloudflare | destination secret (generated; the Hub registers it) | `cf-webhook-auth` equality | alert type |
| Feishu / Lark | verification token (+ encrypt key) | token equality; AES-256-CBC decrypt and `X-Lark-Signature` when encrypted; URL handshake answered | chat id |
| Bitbucket Cloud | webhook secret (generated) | `X-Hub-Signature: sha256=` HMAC | `workspace/repo` |
| CircleCI | signing secret (generated) | `circleci-signature` `v1=` HMAC-SHA256 | project slug `gh/org/repo` |
| Buildkite | token (generated) | `X-Buildkite-Token` equality | pipeline slug |
| Stripe | endpoint signing secret | `Stripe-Signature` `t=`/`v1=` HMAC over `t.body` + 5 min tolerance | event object (`invoice`) |
| Grafana | bearer token (generated) | `Authorization: Bearer` equality | contact point name |
| Opsgenie | header token (generated) | `X-Xmatrix-Token` equality | integration name |
| Netlify | JWS secret (generated) | `X-Webhook-Signature` HS256 JWS with `iss=netlify` and the body's SHA-256 | site name |
| Telegram | secret token (generated) | `X-Telegram-Bot-Api-Secret-Token` equality | chat id |

### Cloudflare

Cloudflare connects with OAuth (`CONNECTOR_CLOUDFLARE_CLIENT_ID` /
`CONNECTOR_CLOUDFLARE_CLIENT_SECRET`, a Cloudflare OAuth client with the
scopes in the manifest) or with an account API token that has Notifications
Edit, Workers Observability Write and Workers Scripts Edit. When the login
reaches more than one account, it still connects; set Account ID on the
connection before subscribing or running actions.

Nothing is configured in the Cloudflare dashboard. The Space's subscriptions
are the authority for which notifications reach xMatrix:

- `@cloudflare:subscribe:<alert type>` checks the type against the account's
  available alerts, creates one webhook destination named `xMatrix · <Space id>`
  for the connection's ingress URL (once), and creates a notification policy
  named `xMatrix · <alert type> · <Space id>` that sends to it. Names carry
  the Space, so Spaces sharing an account never touch each other's policies. A type that needs filters is
  refused with Cloudflare's reason.
- When no Channel in the Space subscribes to the type any more, the Hub
  deletes that Space's policy. Policies with other names are never touched.
- `*` routes every notification the account already sends to the
  destination and configures nothing; the destination's test message reaches
  only `*`.

Each delivery is `fired` or `resolved` (`alert_event`), deduplicated by
`alert_correlation_id` and edge, so an Automation can use
`--on cloudflare:fired:workers_observability_real_time_issue`.

### Outbound Actions And Policy

One action runs per message, written as
`@<provider>:<action>:<target> <text…>`. The text continues across the
following lines. Credentials for actions are saved in the same Credentials
section, and none is ever shown again.

| Provider | Actions |
| --- | --- |
| Slack | `post:<channel id>[/<thread ts>]` |
| Linear | `comment:<ENG-42>`, `create_issue:<team>` (first line is the title) |
| Sentry | `resolve`, `unresolve`, `ignore` `:<short id>` |
| PagerDuty | `read_incident:<incident id>` (read), `acknowledge`, `resolve`, `note` `:<incident id>` |
| GitLab | `comment:<group/project!5 or #12>`, `merge:<group/project!5>`, `retry_pipeline:<group/project/123>` |
| Bitbucket Cloud | `read_pull_request:<workspace/repo!5>` (read), `comment:<workspace/repo!5> <text>` |
| Jira | `read_issue:<ENG-9>` (read), `comment:<ENG-9>`, `transition:<ENG-9> <status>` |
| Vercel | `redeploy:<deployment id>` |
| Cloudflare | `query_logs:<worker> [minutes] [error\|warn\|log]` (read), `list_deployments:<worker>` (read), `rollback:<worker> [version id] [reason]` |
| Feishu | `send:<chat id>` |
| Telegram | `send:<chat id>` |
| Discord | `post:<channel id>` (mentions never ping) |
| Notion | `append:<page id>`, `create_page:<parent page id>` |
| Microsoft Teams (manual), Google Chat, DingTalk, WeCom | `post <text>`, sent to the configured webhook on the provider's own host |
| OpenConnector | `search:<service>` (read), `run:<service.action>[@alias] <json>` (write) against the Space's own runtime |

OpenConnector is a gateway to a Space-owned external runtime, not a built-in
implementation or verification of every provider in its catalog. Save a public
HTTPS runtime URL (no embedded credentials, query or fragment) and a persistent
runtime token. Check authenticates `GET /v1/health` and requires the healthy
`oomol-connect` envelope; it does not prove any third-party account is connected.
Check also requires a random invalid runtime token to receive HTTP 401. Keep
runtime authentication configured after the last persistent token is revoked:
upstream otherwise permits unauthenticated requests when no runtime tokens,
configured runtime token or JWT verifier remain. A token-only runtime must
retain an authentication control before revoking its last persistent token.
Use a runtime token restricted to the intended actions and stable connection IDs,
with no proxy grants. Provider credentials remain in that runtime.

Search requires the token and validates service-qualified action IDs, displaying
at most 30. All `run` calls are writes for xMatrix policy purposes, including
provider actions described as reads: an Agent needs the Channel administrator's
`@openconnector:policy:run allow`. Input is one JSON object up to 16 KiB UTF-8.
The transport has a 10-second timeout, a 256 KiB response limit and no redirects
or automatic replay. A successful run must confirm the exact action, a bounded
execution ID and `auditPersisted: true`; content is fenced, mention-shielded and
explicitly untrusted, with an 800-character preview. An uncertain response can
follow a completed side effect: inspect the runtime/provider before retrying.
Removing the Space connection, denying the Channel policy and revoking the
runtime token are distinct controls; runtime revocation must be tested against
the actual deployment. Gateway/runtime tests do not establish native acceptance
of Gmail, Slack or any other third-party provider.

Policy is stored in `data.app_connector_action_policies` and read at execution
time:

- **`deny`.** A Space admin's `@<provider>:policy:<action> deny` blocks the
  action for everyone in that channel.
- **Agent writes.** An Agent's write action is blocked until a Space admin
  sends `@<provider>:policy:<action> allow` in that channel, unless the action
  is marked `defaultPolicy: "allow"` (Sentry resolve/unresolve/ignore), which
  runs for an Agent by default and can still be denied there.
- **Defaults.** A Human's own command, and any read, otherwise runs.
- **Unknown author.** A message not known to be a Human's is treated as an
  Agent's.

Every attempt writes an execution record and a receipt in the channel.
Persisted completion summaries are limited to 1,000 UTF-8 bytes, and failure or
blocked reasons to 500 UTF-8 bytes. The Hub truncates these excerpts at complete
Unicode code points; the action's full bounded context remains in the tool
result and Channel receipt. Multibyte issue titles and stack metadata therefore
do not prevent an otherwise successful read from finalizing.

**Agents.**
- An Agent can post the command itself with `xmatrix send`.
- An Agent's harness also gets the actions as MCP tools automatically.
  - Claude Code gets them through `--mcp-config`, Codex through `-c mcp_servers.xmatrix_connectors.*`, and ACP harnesses through the session's `mcpServers`.
  - Each one runs `xmatrix connector mcp`, a stdio proxy to `POST /api/connectors/mcp` that uses the Run's current credential.
  - The tools are named `<provider>__<action>`. `tools/list` offers only the providers the Space has connected. Each call runs as the Agent in its Run's channel under the same policy.
  - Set `XMATRIX_CONNECTOR_MCP=0` on a Run to leave them out.

**Automations.** `--on <connector>:<event|*>[:<source>]` fires a page
Automation on a connector event in the same Space, for example
`--on sentry:issue.created:web`. The Space must have that connector connected
when the trigger is written.

Every delivery is untrusted content. It is posted as a bounded quote, and
mentions inside it are shielded so a payload cannot address an Agent. Slack
bot messages and Feishu app messages are dropped, so the Hub's own posts
cannot loop back in.

### Vercel Integration Events

For the registered xMatrix Vercel Integration, configure a webhook to
`https://xmatrix-hub.xmatrix.sh/api/connectors/vercel/events` in its developer
console. Select `deployment.created`, `deployment.ready`, `deployment.succeeded`,
`deployment.error`, `deployment.canceled`, `integration-configuration.removed`
and `integration-configuration.transferred`. Integration webhooks are signed
with the Integration Client Secret, supplied through the canonical production
OAuth pair and formal release train. A per-Space webhook secret is not that key.

Reconnect existing Vercel Spaces to establish an authenticated configuration and
team/personal-account binding. Subscribe the acceptance Channel to the project
name using `@vercel:subscribe:<project name> all`. Hub reads current project
permissions from Vercel for each event; an installation for another project in
the same team does not receive it. Signature failure, missing scope, revoked
configuration and stale credentials fail closed. Removal or team transfer
disconnects the matching current installation without changing a replacement
grant. Transfer to another team requires reconnecting there.

Run a dedicated native deployment through created, ready/succeeded and failed
states and confirm provider delivery receipts and the subscribed Channel. Replay
one delivery to confirm it creates no duplicate message. Keep app configuration,
OAuth/Check, deployment delivery and removal/transfer verification as distinct
acceptance evidence. The original per-Space webhook path remains supported.

## One-Click OAuth

Registered providers can connect with OAuth instead of a pasted token. The Apps
view offers **Connect with \<Provider\>** only once a formal release injects
both canonical GitHub `production` environment secrets for that provider:
`CONNECTOR_<ID>_CLIENT_ID` and `CONNECTOR_<ID>_CLIENT_SECRET`. Registering or
rotating those credentials follows Production Release Intent and its validated
release train; dashboard edits or direct Worker uploads are not deployment authority.

Register each provider's OAuth app with the redirect URI
`<HUB_URL>/api/connectors/oauth/callback`:

| Provider | Where | Scopes |
| --- | --- | --- |
| Slack | api.slack.com/apps → OAuth & Permissions (bot token) | `chat:write channels:read channels:history groups:history reactions:read` |
| Linear | Settings → API → OAuth applications | `read,write` |
| Sentry | Settings → Developer Settings → New Public Integration | `org:read project:read event:write` |
| GitLab | User or group Settings → Applications (gitlab.com) | `api` |
| Atlassian (Jira) | developer.atlassian.com → OAuth 2.0 (3LO) app, Jira API | `read:jira-work write:jira-work offline_access` |
| Notion | notion.so/my-integrations → Public integration | — |
| Vercel | Integration console → External integration (`xmatrix` slug) | Integration Configuration read, Deployments read/write, Projects/Teams/Current User read |
| PagerDuty | Company developer account → Scoped OAuth confidential app | `abilities.read incidents.read incidents.write` |
| Bitbucket Cloud | Company workspace Settings → OAuth consumers (non-private consumer) | `account pullrequest` |

**How the flow works.**
- The signed state binds the provider, the Space and the admin who started
  the flow, and expires after ten minutes.
- The callback stores the tokens as that admin, so the credential store's
  owner/admin check still applies.
- Expiring tokens (Linear, GitLab, Atlassian) are refreshed by the Hub shortly
  before an action uses them.
- OAuth covers outbound actions. Slack/Linear app events use authenticated
  workspace bindings and application signing secrets; Vercel uses the Integration
  binding and Client Secret described above. Other inbound setups use their
  per-connection ingress URL and the provider's signing secret.
- A pasted token keeps working alongside OAuth. Actions prefer the OAuth token
  when one is stored.

### Bitbucket review work

The company consumer uses the common callback and
`CONNECTOR_BITBUCKET_CLIENT_ID` / `CONNECTOR_BITBUCKET_CLIENT_SECRET`, saved as
canonical production secrets. Both are optional until registered, but a partial
pair is rejected by the release. Consumer permissions are fixed in Bitbucket;
requesting a smaller scope at authorization does not narrow its grant. Configure
only `account` and `pullrequest`: the latter includes reading and commenting,
while creating/merging PRs is outside this connector's actions.

The code exchanges authorization codes and refreshes with HTTP Basic consumer
authentication. It requires expiring Bearer grants, the requested scopes, and
rotating refresh tokens; refresh writes use the existing credential-version CAS
before actions run. An incomplete saved grant or unavailable consumer at refresh
time stops execution, as does a failed refresh; writes are not replayed.
API requests use only `https://api.bitbucket.org` with a Bearer header. Check
requests only the current UUID and does not cache an account profile or email.

`read_pull_request` names one `workspace/repo!id`, returns title, description,
state and at most 20 oldest comments, and caps quoted untrusted content at
12,000 characters. Deleted comments, account fields, structured mentions,
attachments and linked resources are omitted; pagination links are never
followed. Free customer text is not a guarantee of zero personal data. Reading
obeys Channel read/deny, independently of the admin's Agent comment allow.

Existing per-Space signed repository webhooks remain available with their
current generated secret; OAuth does not claim to install those webhooks.
An event-only connection cannot execute the new actions without its OAuth grant.
Company workspace/consumer registration, formal release and native PR
read/comment plus signed event acceptance must all complete before availability
is reported.

Sources: [OAuth](https://support.atlassian.com/bitbucket-cloud/docs/use-oauth-on-bitbucket-cloud/),
[May 2026 token changes](https://community.developer.atlassian.com/t/oauth-2-0-and-api-authentication-changes-for-bitbucket-cloud/99003),
[PR API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/).

## Connector Credentials And Event Ingress

Providers other than GitHub keep their credentials in
`data.app_connector_credentials`. This is one AES-GCM envelope per connection,
encrypted with `XMATRIX_SECRET_CATALOG_KEY` and bound to the connection id and
version. See `docs/design/connector-platform.md` §3.2–3.3.

- **Writes.** Space owners and admins write values with
  `PUT /api/spaces/:spaceId/app-connections/:providerId/credentials`. Values an
  admin writes are never returned.
- **Reads.** `GET` on the same path returns only what the Hub generated: the
  ingress URL and any `generated` secret. Connection reads list
  `credentialFields` names only.
- **Ingress.** Deliveries go to
  `POST /api/connectors/:providerId/events/:spaceId/:ingressKey`.
  - An unknown provider, a disconnected connection and a wrong key all return
    the same 404.
  - Next, the provider module verifies its own signature.
  - Each event is then posted, as the provider, to every Channel subscribed to
    its source and feature.
  - Message ids derive from the event id, so a redelivery appends nothing.
- **Deletion.** Deleting the connection or its Space deletes the credential
  row. Space shard moves carry it with the Space.

## Eval Expression And Library

GitHub issue import currently routes through the built-in
`@xmatrix/eval-libraries/issue-first@0.1.0` eval library. This is the team
default library, but the actual eval expression is the concrete issue-import expression or
library export being evaluated. The Hub stores that as eval metadata rather
than a recipe enum, repo binding, or work-item table.

`@github:issue_to_channel` remains the source import atom. When it creates a
work channel, the Hub evaluates the issue-import expression through the library
export `github.issue.import`, records the eval expression/library/language/export
metadata on the channel, and stores a generic environment relation:

- `subjectRef`: `channel:<work-channel-id>`
- `predicate`: `imports-source`
- `objectRef`: `github:issue:<owner>/<repo>#<number>`
- `scopeRef`: `channel:<source-channel-id>`
- `sourceTriggerId`: `@xmatrix/eval-libraries/issue-first:github.issue.import`

The relation is the durable lookup and dedupe surface. It replaces the previous
expression-specific `RepoBinding` and `WorkItemBinding` records. Future Linear,
Notion, incident, release, or custom text should be evaluated through the same
eval boundary and write the same kind of provider-neutral relations instead of
adding provider-specific binding tables.

Repository-wide issue subscriptions use the same provider-neutral relation
store with `predicate: subscribes-source` and an object ref such as
`github:repo:OWNER/REPO`. They do not create a GitHub-specific subscription
authority table. The global directory retains only a rebuildable
installation/repository-to-Channel routing projection; every webhook delivery
re-reads the canonical connection, Channel binding, and selected features from
the owning authority before appending a message.

## GitHub App Platform Secrets

GitHub uses a GitHub App installation flow. Users install the xMatrix GitHub App into their own org/user and select repositories. xMatrix stores only the space connection, installation id, enabled channels, selected agent, and bounded metadata. It does not store user PATs, fine-grained PATs, installation access tokens, or worker-wide repository tokens.

xMatrix does not implement a GitHub permission editor. GitHub's native App
installation and permission-upgrade pages remain the place where repository
access and App permissions are approved. xMatrix reflects the effective
installation permissions as connector capabilities, shows upgrade prompts when
a feature lacks permission, and controls behavior through channel-level feature
subscriptions, approval, and audit.

Configure these Cloudflare Worker secrets for the Hub Worker:

```bash
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_CLIENT_ID
wrangler secret put GITHUB_APP_CLIENT_SECRET
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put GITHUB_WEBHOOK_SECRET
```

The page claim check (`xmatrix/claim`, see
[`pages-and-conversations.md`](../design/pages-and-conversations.md) §5.6)
needs these GitHub App settings:
- the **Checks: write** and **Pull requests: read** repository permissions
  (pre-review reads the change and posts `xmatrix/pre-review`);
- the **Email addresses: read** account permission;
- the callback URL `<HUB_URL>/api/auth/callback/github`, so members can link
  their GitHub account through the App's own OAuth credentials
  (`GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET`).

Also configure `GITHUB_APP_SLUG` as the public GitHub App slug for the install URL. The current executor exchanges the GitHub App private key for a one-hour installation access token at runtime, uses it for issue/PR reads and issue-comment backfill, and never persists that short-lived token.

## Space Connection Setup

In the xMatrix Apps view, configure GitHub for each space that should use it:

- Click `Connect` on the GitHub connector and complete GitHub App installation in GitHub.
- The GitHub callback returns directly to the Space `Apps` view. If organization-owner approval is required, the view reports the installation as pending instead of silently returning without a connection.
- `Disconnect` disables the Space connection and forgets its linked installations; xMatrix routing configuration and scopes are kept. `Connect` then authorizes on GitHub again, and the installation it returns replaces the old ones. Only a connection in error recovers by a check of its retained installations.
- After connecting, click `Configure` to select the default agent that should be added to issue work channels.
- The first successful `@github:subscribe` in a channel creates that channel's GitHub binding. `@github:unsubscribe` removes selected source features and removes the binding when the final subscription is gone. Channel details displays this derived subscription state and opens Composer `@` completion; Space-wide connection management remains in `Apps`.
- Set the default repository as `owner/repo` when users should be able to type short issue refs such as `#42`.
- GitHub write actions follow the generic Channel action policy:
  - `comment`, `create_issue`, `close_issue`, `reopen_issue`, `review`, `rerun_failed_jobs` and `dispatch_workflow` are off by default. They run in a channel only after a Space admin allows them there, either under Apps → GitHub → Channel action policy or with `@github:policy:<action> allow` in that channel.
  - `merge` runs from a Human's own command, and from an Agent's command only where allowed.
  - Migration `0127` converted the retired `*WriteChannelId` metadata into `allow` rows. Those keys are no longer read.
- A GitHub App installation belongs to exactly one User or Organization; a Space links up to 32 of them, and its repositories, webhook delivery and org/repo completion cover every linked installation. The GitHub connector's `GitHub accounts` section, shown whether or not the Space is connected, lists each linked account with `Manage on GitHub` (repository selection for that installation) and `Unlink` (forgets it here; unlinking the last one disconnects). Installations of the App that the admin's linked GitHub account can reach but the Space has not linked are listed with `Link`, which links them directly after the same reachability check as the install callback, since GitHub does not return to xMatrix for an account whose installation is unchanged. `Install on another account` installs the App on a new account. None of these change xMatrix-owned channel/agent/write settings.
- Use full issue URLs or `owner/repo#42` when no default repository is configured.

After setup, a channel message such as:

```text
@github:subscribe:OWNER/REPO:#42
```

subscribes the current channel or thread to the referenced issue or pull
request. Issue imports include title, body, labels, state, referenced media, and
comment backfill. Pull request imports add PR refs, changed-file summaries, and
a checkout hint without embedding code diffs.

To route every commit push, issue, and pull request in a repository, including
subsequent timeline comments, inline review comments, and reviews, subscribe
the current channel at repository scope:

```text
@github:subscribe:OWNER/REPO all
```

Composer completion follows the same segments. Type `@github:`, choose `Subscribe`,
choose an owner or organization, and then choose one of the repositories accessible
to the Space's GitHub App installation. Repository names are loaded only for the
selected owner and only when the connector is enabled for the current channel.

Repository subscriptions support `issues`, `pulls`, `comments`, `reviews`,
`commits`, `checks`, `status`, and `releases`. The `all` shorthand expands to
all eight features for both
`subscribe` and `unsubscribe`; use the individual names when only some event
types are wanted.
`comments` follows the selected source kinds: with `issues` it includes Issue
comments, and with `pulls` it includes pull request timeline and inline review
comments. Features can be removed independently, for example
`@github:unsubscribe:OWNER/REPO reviews`. Omitting features retains the
backward-compatible `issues comments` default. Repository subscriptions do not
backfill existing items or commits; they deliver future matching webhook events.
The `commits` feature summarizes each GitHub `push` delivery with its branch or
tag, pusher, commit range, compare URL, and up to 8 commit SHA/message entries.

The product model follows a Slack-style feature subscription approach: users
choose which channel features such as commits, issues, pulls, comments, reviews, checks,
statuses, and releases should appear in a channel. Missing GitHub App
permissions produce a GitHub permission-upgrade prompt instead of xMatrix
offering a custom permission editor.

Default channel delivery stays low-noise: issue and pull request summary cards
may appear in the subscribed channel, while subscriptions that include comments
or reviews create a linked thread for follow-up delivery. Check details and
other follow-up update routing should follow the same thread-first pattern
before channel broadcast behavior is added.

Feature words can be included in subscribe and unsubscribe commands. For
example, `@github:subscribe:OWNER/REPO:#42 pulls reviews` subscribes the
current channel to PR summary and review updates, while
`@github:unsubscribe:OWNER/REPO:#42 reviews` removes review delivery from the
current channel's subscription. Omitting features uses the default feature set
for the target kind.

Comment writes use `@github:comment:OWNER/REPO:#42 <body>`. The action is
disabled by default and requires the space GitHub connection to name an enabled
comment-write channel. The executor uses a short-lived GitHub App installation
token, requires the relevant write capability, records the app execution result,
and posts only the resulting comment URL back to the channel.

Issue creation uses `@github:create_issue:OWNER/REPO <title>` with an optional
multi-line body after the first line. The action is disabled by default and
requires the space GitHub connection to name an enabled create-issue channel.
The executor uses a short-lived GitHub App installation token, requires
`github.issues.write`, records the app execution result, and posts only the
created issue URL back to the channel.

Issue and pull request state changes use
`@github:close_issue:OWNER/REPO:#42` and
`@github:reopen_issue:OWNER/REPO:#42`. These actions are disabled by default
and require the space GitHub connection to name an enabled close/reopen channel.
The executor uses a short-lived GitHub App installation token, requires the
relevant issue or pull request write capability, records the app execution
result, and posts only the target URL back to the channel.

Pull request reviews use
`@github:review:OWNER/REPO:#42 <approve|request_changes|comment> <body>`.
The action is disabled by default and requires the space GitHub connection to
name an enabled review-write channel. The executor uses a short-lived GitHub
App installation token, requires `github.pull_requests.write`, records the app
execution result, and posts only the review URL back to the channel.

Pull request merges use
`@github:merge:OWNER/REPO:#42 [merge|squash|rebase]`. Merge is enabled by
default in every Channel where the GitHub connector itself is enabled; it does
not require a separate write-Channel allowlist. The Hub uses a short-lived,
repository-scoped GitHub App token, requires `github.pull_requests.write`, and
records the execution and result. GitHub remains authoritative for branch
protection, required checks, and allowed merge methods. Omitting the method uses
the GitHub API default for the repository.

GitHub Actions mutations are separately disabled until the Space configuration
selects one Actions write Channel and the GitHub App installation grants
`actions:write`. Workflow dispatch also requires its exact workflow file name
or numeric id in the connection's dispatch allowlist. Failed jobs in an
existing run can then be retried with:

```text
@github:rerun_failed_jobs:OWNER/REPO:RUN_ID
```

This action deliberately exposes only GitHub's failed-job rerun operation, not
the broader arbitrary Actions REST surface. A workflow can be dispatched with:

```text
@github:dispatch_workflow:OWNER/REPO:WORKFLOW.yml:REF {"input_name":"value"}
```

The workflow identifier is either a positive numeric id or a `.yml`/`.yaml`
file name, the ref is an explicit bounded Git ref, and the optional input body
must be a JSON object with at most ten scalar string, number, or Boolean values.
An unlisted workflow is rejected before a token is minted. Both actions mint a short-lived token down-scoped to the named repository,
require the freshly minted token itself to report `github.actions.write`, record
the execution, and post only a bounded result summary to the Channel. Persisted
connection scopes cannot substitute for a missing installation permission.

Advanced customer-owned GitHub Apps are a future deployment path for
organizations that need to define their own App registration, permissions, and
events. That path must still store only secret references and installation
references in xMatrix records.

GitHub issue and issue comment webhooks are accepted at:

```text
https://xmatrix-hub.xmatrix.sh/api/apps/github/webhook
```

The Hub verifies `X-Hub-Signature-256` with `GITHUB_WEBHOOK_SECRET`, then posts matching issue, pull request, comment, and review updates into subscribed channels or work threads.

## Remaining Milestones

- Expand Slack-style GitHub feature subscription UI around the command-level commits, issues, pulls, comments, reviews, checks, statuses, and releases model.
- Add a customer-owned GitHub App setup path for organizations that require full GitHub-native permission customization without PATs.
- Reintroduce additional GitHub write actions only when their executors, GitHub App permissions, and approval boundaries are implemented.


### PagerDuty company application

Register **Scoped OAuth**, a confidential app, with the common callback; configure
`abilities.read incidents.read incidents.write`. Save `CONNECTOR_PAGERDUTY_CLIENT_ID`
and `CONNECTOR_PAGERDUTY_CLIENT_SECRET` as a complete canonical production pair.
The formal release emits both or rejects a partial rotation; when both are absent,
one-click Connect is unavailable and manual setup remains available. Publication
is required before this Scoped app works for other PagerDuty accounts, and their
administrators must install it. Own-account registration is not cross-account acceptance.

The Hub handles S256 proof, actual granted scope validation, signed account/US-EU
region evidence and rotating tokens. Do not enter those managed fields or reuse
Classic OAuth. A malformed/partial grant, changed app, or failed refresh requires
reconnection; the Hub never retries an uncertain incident write. Check calls the
regional abilities API without retrieving user profiles. Manual keys use `apiRegion`
(`us`, default, or `eu`); manual writes also require `fromEmail`. OAuth ignores
manual region/email and acts as its consenting user.

Inbound incidents still require a separately installed Generic Webhook v3,
its signing secret and per-Space ingress URL, and an explicit Channel subscription.
OAuth alone does not prove events configured. Verify company Connect → regional
API Check → policy-controlled read/write on a dedicated incident → signed inbound
triggered/acknowledged/resolved before recording end-to-end acceptance. See the
[Scoped OAuth design](../design/connector-platform.md#pagerduty-scoped-oauth)
for signed-token validation and current discovery evidence.


## Discord company bot registration and acceptance

Use the company `hello@xmatrix.sh` identity after its native account challenge is
completed. Register xMatrix with its official avatar, Guild Install support,
Public Bot enabled and Requires OAuth2 Code Grant enabled. Register the exact
callback `https://xmatrix-hub.xmatrix.sh/api/connectors/oauth/callback`. The Connect
URL requests `bot identify` and View Channel/Send Messages (`3072`); do not add
Administrator, guild management, DM, history, privileged intents or an interaction
endpoint for the existing outbound feature.

Save the client ID, client secret and bot token securely to company Space aliases
and production canonical `CONNECTOR_DISCORD_CLIENT_ID`,
`CONNECTOR_DISCORD_CLIENT_SECRET`, `CONNECTOR_DISCORD_BOT_TOKEN`. Inject the complete
group with the official Hub release intent and verify actual final receipts before
native consent. Leave the group absent while registration is blocked; fixtures or
manual own-bot credentials are not evidence of company registration.

In Apps, a Human Space admin selects Connect with Discord and explicitly chooses
an isolated test guild in native consent. Return to the same Space, reload and run
Check. Enable the `post` action policy from a Human admin in the E2E Channel, post
one unique marker to a test text channel and verify it in the native Discord UI.
Confirm a different guild/DM is rejected, then revoke the authorization or remove
the bot and verify a later post cannot dispatch. Reconnect through native consent;
check that a delayed old callback cannot replace it. Keep another Space's shared
bot installation intact during cleanup. No raw bot/user tokens belong in chat,
logs or installation snapshots. Track native registration, deployment, Check,
Agent message action and revocation separately. This outbound-only installation
does not prove incoming Discord messages or Marketplace approval.

For signed lifecycle acceptance, after the company app exists, capture its
**Public Key** (`verify_key` in the Application API) directly into Space/GitHub
production `CONNECTOR_DISCORD_PUBLIC_KEY` through canonical stdin. Do not put
credentials, complete payloads, or authorization URLs into chat. Deploy through
Production Release Intent and verify the immutable tag, production PostgreSQL,
Hub/Web and both final receipts. Then configure **Webhooks → Endpoint URL** as
`https://xmatrix-hub.xmatrix.sh/api/connectors/discord/events`, enable Events, select
`APPLICATION_AUTHORIZED` and `APPLICATION_DEAUTHORIZED`, save, and confirm native
PING verification (204, empty response, `Content-Type: application/json`). This is a Webhook Events URL, not an
Interactions Endpoint URL or an incoming channel webhook.

Reconnect existing company grants so the verified app/guild/user lifecycle
binding and signed Connect start exist. Record actual native authorization,
Webhook delivery and xMatrix current connection evidence separately. Remove the
application from the installing user's Authorized Apps and prove the real
DEAUTHORIZED delivery clears only that user's matching company grants; verify
Check/post cannot use the old grant and an explicit newer Connect survives old
delivery retries. Native guild bot removal is a separate live membership denial,
not a guessed DEAUTHORIZED guild payload. Observe unrelated Space/user/manual
connections during scoped cleanup. Real provider/browser receipts remain
required: local signatures/PG tests, a saved endpoint, and HTTP204 alone do not
prove native installation or revocation. Ordinary guild message ingress remains
unimplemented pending Gateway support and must not be marked accepted.

### Shared Telegram company bot

The company bot uses two canonical Hub secrets:
`CONNECTOR_TELEGRAM_BOT_TOKEN` and `CONNECTOR_TELEGRAM_WEBHOOK_SECRET`.
Save both through the designated secret store/stdin and GitHub production
credentials; never paste their values into commands, Pages or messages. A formal
Hub/Web release validates the complete pair. With neither configured, existing
manual per-Space bot connections remain available.

After release, the company account owner registers the bot's HTTPS webhook at
`https://xmatrix-hub.xmatrix.sh/api/connectors/telegram/events`, using an app-bound delivery `secret_token` and `allowed_updates` of exactly `message` and `my_chat_member`.
Compute the delivery token inside the scoped secret execution boundary as the
lowercase SHA-256 hex of UTF-8 `JSON.stringify(["xmatrix-telegram-webhook-v1",
BOT_TOKEN, WEBHOOK_SECRET])`, where the two values come from the canonical
secrets. `CONNECTOR_TELEGRAM_WEBHOOK_SECRET` is the private seed, not the raw
header value. Do not output the derived token or use the stored app fingerprint
as authentication. A token-only rotation changes this derivation too; reconfigure
the webhook using the new value after formal deployment. Old bot deliveries must
fail authentication even if the canonical seed was retained.
Do not delete a live webhook or drop pending updates as part of verification.
Keep bot privacy and administrator rights unchanged. Native Check reads the
current webhook configuration and group membership; it does not alter them.

In Apps → Telegram, a Human Space owner/admin enters the negative group ID and
starts confirmation. A current Telegram group administrator sends the private
bot-addressed command in that group within three minutes, then refreshes Apps.
No bot token is needed in this form. Subscribe to `telegram:<negative-group-id>`
with `messages`. Delivery is limited to updates Telegram provides under its
privacy mode. Group removal or migration requires a new explicit confirmation;
automatic rejoining cannot restore access. A Space supports twenty groups and
can unlink each one independently.

Agent sends additionally require the Channel's current action policy. Verify a
single authorized test message and its real provider receipt, authenticated
inbound message, and bot-removal denial before recording native E2E completion.
Manual credentials replace all company group grants for that Space. Company
registration, code deployment, actual acceptance and Marketplace listing remain
separate statuses.

### DingTalk company suite registration callback

The native registration prerequisite is separate from the custom group robot
webhook. Create the company third-party enterprise app in the actual DingTalk
developer console using the company's identity. Verify whether its current
console supports the encrypted HTTP suite callback before selecting that mode;
the endpoint does not implement Stream mode. Preserve the registered SuiteKey
as receiver authority, including during URL validation. Do not replace it with
a key copied from an incoming request or an undocumented creation placeholder.

Store these four actual values through stdin in the Space secret catalog and
the GitHub `production` environment, then request a formal Hub release:
`CONNECTOR_DINGTALK_SUITE_KEY`, `CONNECTOR_DINGTALK_SUITE_SECRET`,
`CONNECTOR_DINGTALK_CALLBACK_TOKEN`, `CONNECTOR_DINGTALK_ENCODING_AES_KEY`.
The callback token is 3–32 ASCII letters/digits; the AES key is the canonical
43-character Base64 representation of 32 bytes. Partial or malformed pairs
cannot deploy. Values never go in a Channel, PR, fixture or diagnostic artifact.

Set the native callback URL to
`https://xmatrix-hub.xmatrix.sh/api/connectors/dingtalk/suite`. Verify the real
encrypted URL challenge and the app's actual ticket push. A pushed ticket is
encrypted in primary PostgreSQL and remains current until replaced; it is not a
company installation or Space grant. Unconfigured requests return 503.

For the separately verified suite-ticket/SyncHTTP mode, configure
`CONNECTOR_DINGTALK_COMPANY_CONFIG` with exactly protocol/delivery/suiteId/
developerCorpId/appId/templateId/templateField after reading actual console
metadata and the approved template schema. The native suite keys alone do not
turn on company routes. The encrypted SyncHTTP URL is
`https://xmatrix-hub.xmatrix.sh/api/connectors/dingtalk/events`; it persists typed
ticket/scope/retirement/member-change receipts before encrypted success and
refuses unsupported or slow batches. Stream remains separate.

A Human Space admin selects one company and 1–20 explicit members in Apps,
uses the native management login for an already activated company app, verifies
the confidential authCode identity against the selected company and current
company/application administrator authority, then confirms the original Space
and members. The unsigned adminConsent success flag cannot establish a grant.
Current signed full visibility and provider contact permission must include every
selected member; provider application activation remains a native prerequisite.
Check and generation-bound `read`/policy-controlled `send` actions repeat current
grants. `send` requests an approved template; task_id is acceptance, not delivery.
Current actual console mode, signed complete initial scope and approved template
remain prerequisites; do not fill production values from fixtures. General
Channel/Automation contact routing and an asynchronous business-event inbox
remain unimplemented. Keep robot webhook behavior independent. See
[the company design](../design/dingtalk-company-suite.md) for implementation
boundaries, real acceptance prerequisites and official protocol sources.

### WeCom company suite registration callback

The company suite provides `GET`/`POST` at
`https://xmatrix-hub.xmatrix.sh/api/connectors/wecom/suite` for the encrypted
URL challenge, real ticket push and company authorization retirement. Save the
actual four canonical keys using the designated secret store/stdin and GitHub
production: `CONNECTOR_WECOM_SUITE_ID`, `CONNECTOR_WECOM_SUITE_SECRET`,
`CONNECTOR_WECOM_CALLBACK_TOKEN`, `CONNECTOR_WECOM_ENCODING_AES_KEY`.
The token is 1–32 ASCII letters/digits; AES is canonical 43-character Base64 of
32 bytes. Formal Hub release validates the complete set. With no suite, native
routes return 503; the per-Space group robot remains its independent mode.
Never put private values, authorization codes or tickets in commands, Pages,
logs or screenshots.

After formal Hub/Web deployment and actual key injection, configure the command
callback above and data callback `/api/connectors/wecom/events` with the same
actual token/AES pair. Verify native URL challenges and a real ticket push, then
launch Apps → WeCom → Authorize company. Select the appropriate test/formal mode;
the company's administrator must set explicit member visibility and the original
xMatrix Space admin confirms one to twenty recipients at `/connect/wecom`.
The Hub then checks current native authorization, basic contact permissions,
enabled agent and active visible members. Copy opaque source/recipient references
from Refresh connection to subscribe and invoke `@wecom:send:<recipient> <text>`
under a separately authorized Channel policy. Group webhook posts use the
independent `post` action. Saving that webhook replaces the native installation.

Real incoming text produces a notification without exposing native content.
Company authorization changes/cancellation purge the prior permanent code and
confirmed member range; reauthorization requires a fresh website confirmation.
Marketplace `create_auth` remains unimplemented and returns 503. Registration,
installation, source-IP allowlisting, interface licensing, actual Check/send,
notification latency/deduplication and retirement all require separate native
receipts. No license order, trusted-IP setting, paid plan or identity substitute
is created by this code. Until those receipts exist, keep native acceptance open.

The complete contract and current official v2 API sources are in
[WeCom company suite](../design/wecom-company-suite.md). Check the current
provider UI before choosing the actual company registration path; do not replace
it with a personal account, purchase a plan or widen an IP allowlist implicitly.

## Teams company bot

Native Teams personal/groupChat support uses a company SingleTenant bot and Human Space admin confirmation. The canonical registration, authorization, receipt, revocation and acceptance contract is in [Teams company bot](../connectors/teams-native.md). Teams Workflows webhook connections remain outbound-only. Legacy Office 365 Connectors stopped working in May 2026; preserve their existing records but do not create new legacy registrations or describe them as native acceptance. Native corporate registration and acceptance must be recorded separately from release validation.
