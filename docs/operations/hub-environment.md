# Hub environment

<!-- Generated from packages/hub/src/hub-environment.ts by `pnpm --filter @xmatrix/hub env:doc`. Do not edit by hand. -->

Every binding, secret and variable the Hub Worker reads. A Hub test fails when this file and the catalog disagree.

## Required

Every deployment provides these. Secrets go in with `wrangler secret put` (or `--secrets-file`); bindings come from the rendered config.

| Name | Kind | What it does |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | secret | Signs sessions and tokens. Unset: the Hub cannot authenticate anyone. |
| `RELAY_POSTGRES` | binding | Hyperdrive binding to the primary PostgreSQL database (profile `hub.hyperdrive`). Every product authority reads and writes it. |
| `RELAY_R2_CAPABILITY_HMAC_SECRET` | secret | Signs short-lived R2 capability URLs for attachments and history (at least 32 bytes). Unset or shorter: those routes answer 503 `capability_security_unavailable`. |
| `SEND_EMAIL` | binding | Cloudflare email binding that sends sign-in codes and invites. Unset: email sign-in and invites cannot be sent. |
| `XMATRIX_SECRET_CATALOG_KEY` | secret | Encrypts Space secrets (at least 32 characters). Unset: Space secrets cannot be stored or read. |

## Deployment profile

Set under `hub.vars` (or derived from the origins) in `deploy/profiles/<name>.json`; see `deploy/README.md`.

| Name | Kind | What it does |
| --- | --- | --- |
| `APP_URL` | var | Web origin; rendered from the profile's `web.origin`. Unset: links, redirects and auth fail closed. |
| `AUTH_COOKIE_DOMAIN` | var | Shared cookie domain for the Web and Hub origins (e.g. `.example.com`). Unset: cookies stay host-only, which suits localhost only. |
| `AUTH_COOKIE_PREFIX` | var | Cookie name prefix, for a deployment nested under another's cookie domain. |
| `HUB_URL` | var | Hub origin and token issuer; rendered from the profile's `hub.origin`. Unset: authentication fails closed. |
| `PLATFORM_ADMIN_EMAILS` | var | Operator emails allowed to read the platform overview. |
| `PLATFORM_ADMIN_SPACE_ID` | var | Space whose members are platform admins. Optional. |
| `XMATRIX_EMAIL_FROM` | var | Sender address for sign-in mail; defaults to `noreply@` the Web origin's host. |
| `XMATRIX_INVITE_EMAIL_FROM` | var | Sender address for invites; defaults to XMATRIX_EMAIL_FROM. |
| `XMATRIX_RUNTIME_LOCATION_HINT` | var | Durable Object location hint (e.g. `apac`) for Runtime cells, which must sit next to PostgreSQL. Unset: cells are created near their first caller. |

## Optional features

Leave unset to keep the feature off.

| Name | Kind | What it does |
| --- | --- | --- |
| `CONNECTOR_DINGTALK_COMPANY_CONFIG` | secret | Verified company-console JSON: suite-ticket protocol, sync-http delivery, numeric suiteId, developerCorpId, appId and approved templateId/templateField. Requires complete native suite keys; unset keeps company routes and actions unavailable. |
| `DIAGNOSTICS_AE` | binding | Analytics Engine dataset for client diagnostics. Unset: diagnostics are dropped. |
| `DIAGNOSTICS_HASH_SECRET` | secret | Key that pseudonymizes users in diagnostics; defaults to BETTER_AUTH_SECRET. |
| `GITHUB_APP_CLIENT_ID` | var | GitHub App OAuth client id. |
| `GITHUB_APP_CLIENT_SECRET` | secret | GitHub App OAuth client secret. |
| `GITHUB_APP_ID` | var | GitHub App id for the Space GitHub connection. Unset with the other GITHUB_APP_* values: Spaces cannot connect GitHub. |
| `GITHUB_APP_PRIVATE_KEY` | secret | GitHub App private key (PEM). |
| `GITHUB_APP_SLUG` | var | GitHub App slug used for install links. |
| `GITHUB_WEBHOOK_SECRET` | secret | GitHub App webhook signing secret. |
| `GOOGLE_CLIENT_ID` | secret | Google OAuth client id. Unset with its secret: Google sign-in is hidden. |
| `GOOGLE_CLIENT_SECRET` | secret | Google OAuth client secret. |
| `JEV_AI_GATEWAY_API_KEY` | secret | Vercel AI Gateway key for Jev, the model that picks which Agent answers. Unset: message-triggered launches run without Jev's choice, while launches that need a choice (registration input dispatch) answer 503 `registration_selection_unconfigured`. |
| `RATE_LIMIT_ANONYMOUS` | binding | Workers Rate Limiting allowance per client IP for requests without a credential. Unset: they are not counted. |
| `RATE_LIMIT_CREDENTIAL` | binding | Workers Rate Limiting allowance per bearer credential. Unset: credentialed requests are not counted. |
| `RATE_LIMIT_HUMAN_CONNECT` | binding | Workers Rate Limiting allowance of Human socket sign-ins per user. Unset: sign-ins are not counted. |
| `RELAY_AUTHORITY_OBSERVABILITY_AE` | binding | Analytics Engine dataset for authority and PostgreSQL timing. Unset: observation is off. |
| `RELAY_POSTGRES_SHARD_1` | binding | Hyperdrive binding to a second database shard. Unset: every Space is placed on the primary shard. |
| `RELAY_POSTGRES_SHARD_1_ID` | var | Shard id served by RELAY_POSTGRES_SHARD_1; set with it in the deployment profile. |
| `RELAY_POSTGRES_SHARD_2` | binding | Optional further database shard. |
| `RELAY_POSTGRES_SHARD_2_ID` | var | Shard id served by RELAY_POSTGRES_SHARD_2. |
| `RELAY_POSTGRES_SHARD_3` | binding | Optional further database shard. |
| `RELAY_POSTGRES_SHARD_3_ID` | var | Shard id served by RELAY_POSTGRES_SHARD_3. |
| `RELAY_POSTGRES_SHARD_4` | binding | Optional further database shard. |
| `RELAY_POSTGRES_SHARD_4_ID` | var | Shard id served by RELAY_POSTGRES_SHARD_4. |
| `SLACK_CLIENT_ID` | secret | Slack OAuth client id for the Slack connector. Unset: the Slack connector cannot be connected. |
| `SLACK_CLIENT_SECRET` | secret | Slack OAuth client secret. |
| `STRIPE_PRO_ANNUAL_PRICE_ID` | var | Stripe price for the annual Pro seat. |
| `STRIPE_PRO_MONTHLY_PRICE_ID` | var | Stripe price for the monthly Pro seat. |
| `STRIPE_SECRET_KEY` | secret | Stripe API key for paid plans. Unset with the webhook secret: checkout and the billing portal answer 503. |
| `STRIPE_WEBHOOK_SECRET` | secret | Stripe webhook signing secret. |

## Tuning

Optional overrides of code defaults.

| Name | Kind | What it does |
| --- | --- | --- |
| `BETTER_AUTH_JWKS_URL` | var | JWKS URL for verifying session tokens; defaults to the Hub's own. |
| `GITHUB_API_BASE_URL` | var | GitHub API origin (default https://api.github.com), for GitHub Enterprise. |
| `POSTGRES_BACKGROUND_ADMISSION_STRIPES` | var | Permit stripes per shard (default 4). |
| `POSTGRES_BACKGROUND_PASS_LIMIT` | var | Concurrent background passes per shard (default 8). |
| `POSTGRES_COORDINATION_OBSERVABILITY_SAMPLE_RATE` | var | 1-in-N sampling of message coordination summaries. |
| `POSTGRES_QUERY_OBSERVABILITY_SAMPLE_RATE` | var | 1-in-N sampling of successful query points (default 10). |
| `POSTGRES_SESSION_OBSERVABILITY_SAMPLE_RATE` | var | 1-in-N sampling of successful session points (default 1). |
| `RELAY_AUTHORITY_OBSERVABILITY_SLOW_MS` | var | Requests at or above this wall time are never sampled away. |

## Product configuration

Declared by the committed `packages/hub/wrangler.toml`. Deployments do not change these.

| Name | Kind | What it does |
| --- | --- | --- |
| `ATTACHMENT_BUCKET` | binding | R2 bucket for attachments and avatars. |
| `AUTH_AUTHORITY` | var | Authority selector for accounts and sessions; the committed config pins "postgres". |
| `CF_VERSION_METADATA` | binding | Worker version metadata reported by health and diagnostics. |
| `CLIENT_COMPATIBILITY_LEGACY_ADMISSION_ENABLED` | var | Admits the last client generation that sends no compatibility identity. |
| `DEVICE_AUTH` | binding | Device-code login broker for the CLI and apps. |
| `GITHUB_REPOSITORY_TOKEN_LEGACY_UNBOUND_ENABLED` | var | Mints repository tokens for daemons that name no Run (pre-binding CLI); refused unless "true". |
| `MACHINE_NAME_REQUIRED` | var | Require a recorded owner-chosen Machine name before enrollment, connect or recovery; production pins true. |
| `RATE_LIMIT_ENFORCED` | var | Refuses over-limit requests with 429 and Retry-After only when "true"; otherwise they are only logged. |
| `RELAY_AGENT_APP_POLICY_LOCATOR` | binding | Retired Durable Object namespace, kept bound as a 410 shell over its historical rows. |
| `RELAY_AUTHORITY_OBSERVABILITY_ENABLED` | var | Writes authority observation only when "true". |
| `RELAY_AUTOMATION_EXECUTION_ENABLED` | var | Runs Automation occurrences; off when unset. |
| `RELAY_AUTOMATION_RUN_TIMEOUT_MS` | var | Default deadline for Automation runs without their own timeout. |
| `RELAY_CHANNEL_FAMILY_DATA` | binding | Retired Durable Object namespace, kept bound as a 410 shell over its historical rows. |
| `RELAY_CHANNEL_FAMILY_DIRECTORY` | binding | Retired Durable Object namespace, kept bound as a 410 shell over its historical rows. |
| `RELAY_CONTROL_PLANE_DIRECTORY` | binding | Retired Durable Object namespace, kept bound as a 410 shell over its historical rows. |
| `RELAY_GLOBAL_DIRECTORY_AUTHORITY` | binding | Retired Durable Object namespace, kept bound as a 410 shell over its historical rows. |
| `RELAY_PAGE_SESSION` | binding | One live co-editing session per page. |
| `RELAY_PAYLOAD_BUCKET` | binding | R2 bucket for message payloads and projections. |
| `RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL` | binding | Per-Channel Agent Launch coordinator. |
| `RELAY_POSTGRES_BACKGROUND_ADMISSION` | binding | Per-shard permits for background passes. |
| `RELAY_POSTGRES_CHANNEL_COORDINATOR` | binding | Per-Channel message sequence coordinator. |
| `RELAY_POSTGRES_SHARD_ID` | var | Shard id the primary database serves (`shard-0`). |
| `RELAY_RANK_AUTHORITY_DIRECTORY` | binding | Retired Durable Object namespace, kept bound as a 410 shell over its historical rows. |
| `RELAY_RUNTIME` | binding | Runtime cells holding live Agent and client connections. |
| `RELAY_RUNTIME_ROUTE_DIRECTORY` | binding | Runtime delivery-scope to cell directory. |
| `RELAY_SCOPED_CONTROL_AUTHORITY` | binding | Retired Durable Object namespace, kept bound as a 410 shell over its historical rows. |
| `RELAY_SPACE_CAPACITY_AUTHORITY` | binding | Retired Durable Object namespace, kept bound as a 410 shell over its historical rows. |
| `RELAY_SPACE_DELETION_CLOCK` | binding | Per-Space clock for Space deletion purges. |
| `RELAY_SPACE_PROJECTION` | binding | Retired Durable Object namespace, kept bound as a 410 shell over its historical rows. |
| `RELAY_SUMMON_DECISION_CLOCK` | binding | Per-Space clock for decision retention. |
| `XMATRIX_RUNTIME_CELL_MODE` | var | Runtime cell routing; "dual" activates candidate cells. |

## Official deployment operations

Used only by the operators of the hosted xMatrix deployment. Leave unset.

| Name | Kind | What it does |
| --- | --- | --- |
| `CONTROL_PLANE_OPERATOR_TOKEN` | secret | Machine credential for control-plane partition operator routes. |
| `TEST_ENVIRONMENT_ACCESS_SPACE_ID` | var | Space whose members may switch to the hosted Test deployment; leave unset. |
| `XMATRIX_ADMIN_TOKEN` | secret | Legacy internal admin bearer. |

## Local and test deployments

Never set these in production.

| Name | Kind | What it does |
| --- | --- | --- |
| `AUTH_DB` | binding | D1 auth database of the pre-PostgreSQL test configs. |
| `RELAY_AGENT_APP_POLICY_AUTHORITY` | binding | Pre-PostgreSQL Agent/App policy authority; bound only by test configs. |
| `RELAY_CHANNEL_CATALOG_AUTHORITY` | binding | Pre-PostgreSQL Channel catalog authority; bound only by test configs. |
| `RELAY_PROJECTION_AUTHORIZATION_AUTHORITY` | binding | Pre-PostgreSQL projection authorization; bound only by test configs. |
| `RELAY_SCHEDULER_AUTHORITY` | binding | Pre-PostgreSQL scheduler authority; bound only by test configs. |
| `RELAY_SPACE_MEMBERSHIP_AUTHORITY` | binding | Pre-PostgreSQL membership authority; bound only by test configs. |
| `RELAY_SPACE_ROOT_AUTHORITY` | binding | Pre-PostgreSQL Space root authority; bound only by test configs. |
| `RELAY_TRACE_ACCESS_AUTHORITY` | binding | Pre-PostgreSQL Trace grant authority; bound only by test configs. |
| `RELAY_TRACE_ACCESS_LOCATOR` | binding | Pre-PostgreSQL Trace grant locator; bound only by test configs. |
| `RELAY_TRACE_ACCESS_USER_INDEX` | binding | Pre-PostgreSQL Trace grant index; bound only by test configs. |
| `RELAY_USER_PREFERENCE_AUTHORITY` | binding | Pre-PostgreSQL preference authority; bound only by test configs. |
| `XMATRIX_MOCK_AUTH_AVATAR_URL` | var | Mock user avatar URL. |
| `XMATRIX_MOCK_AUTH_EMAIL` | var | Mock user email. |
| `XMATRIX_MOCK_AUTH_NAME` | var | Mock user name. |
| `XMATRIX_MOCK_AUTH_TOKEN` | secret | Bearer token that signs in the mock user; never set in production. |
| `XMATRIX_MOCK_AUTH_USER_ID` | var | Mock user id. |
| `XMATRIX_MOCK_AUTH_USERS` | var | JSON map of mock tokens to users. |
| `XMATRIX_MOCK_SCHEDULE_DELAY_MS` | var | Automation cadence seed honored only with mock auth. |
