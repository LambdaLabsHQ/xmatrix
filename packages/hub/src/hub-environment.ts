import type { Env } from "./types";

/**
 * Every binding, secret and variable the Hub Worker reads, and who provides it.
 *
 * `satisfies Record<keyof Env, …>` keeps this list exactly in step with `Env`:
 * adding or removing an `Env` key without updating it fails the typecheck.
 * `pnpm --filter @xmatrix/hub env:doc` renders it to
 * `docs/operations/hub-environment.md`; a Hub test fails when that file is stale.
 */
export type HubEnvironmentKind = "binding" | "secret" | "var";

/**
 * - `required`: every deployment provides it.
 * - `feature`: optional; leaving it unset turns the named feature off.
 * - `deployment`: deployment-owned value from the deployment profile.
 * - `product`: set by the committed Wrangler config; deployments do not change it.
 * - `tuning`: optional override of a code default.
 * - `operator`: only the official hosted deployment's operators use it; leave unset.
 * - `test`: local and hosted-test deployments only; never set in production.
 */
export type HubEnvironmentScope =
  | "required"
  | "feature"
  | "deployment"
  | "product"
  | "tuning"
  | "operator"
  | "test";

export interface HubEnvironmentEntry {
  kind: HubEnvironmentKind;
  scope: HubEnvironmentScope;
  /** What it is for and, where it matters, what happens when it is unset. */
  summary: string;
}

const product = (kind: HubEnvironmentKind, summary: string): HubEnvironmentEntry => ({ kind, scope: "product", summary });
const tuning = (summary: string): HubEnvironmentEntry => ({ kind: "var", scope: "tuning", summary });
const test = (kind: HubEnvironmentKind, summary: string): HubEnvironmentEntry => ({ kind, scope: "test", summary });
/** The Durable Object control plane retired; its namespaces answer 410 over their historical rows. */
const retired = product("binding", "Retired Durable Object namespace, kept bound as a 410 shell over its historical rows.");
const operator = (kind: HubEnvironmentKind, summary: string): HubEnvironmentEntry => ({ kind, scope: "operator", summary });
const authority = (domain: string): HubEnvironmentEntry =>
  product("var", `Authority selector for ${domain}; the committed config pins "postgres".`);

export const HUB_ENVIRONMENT = {
  // Durable Object namespaces (declared in the committed config).
  RELAY_SUMMON_DECISION_CLOCK: product("binding", "Per-Space clock for decision retention."),
  RELAY_SPACE_DELETION_CLOCK: product("binding", "Per-Space clock for Space deletion purges."),
  RELAY_PAGE_SESSION: product("binding", "One live co-editing session per page."),
  RELAY_SCOPED_CONTROL_AUTHORITY: retired,
  RELAY_CHANNEL_FAMILY_DATA: retired,
  RELAY_CHANNEL_FAMILY_DIRECTORY: retired,
  RELAY_POSTGRES_CHANNEL_COORDINATOR: product("binding", "Per-Channel message sequence coordinator."),
  RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL: product("binding", "Per-Channel Agent Launch coordinator."),
  RELAY_POSTGRES_BACKGROUND_ADMISSION: product("binding", "Per-shard permits for background passes."),
  RELAY_CHANNEL_CATALOG_AUTHORITY: test("binding", "Pre-PostgreSQL Channel catalog authority; bound only by test configs."),
  RELAY_SCHEDULER_AUTHORITY: test("binding", "Pre-PostgreSQL scheduler authority; bound only by test configs."),
  RELAY_PROJECTION_AUTHORIZATION_AUTHORITY: test("binding", "Pre-PostgreSQL projection authorization; bound only by test configs."),
  RELAY_SPACE_MEMBERSHIP_AUTHORITY: test("binding", "Pre-PostgreSQL membership authority; bound only by test configs."),
  RELAY_USER_PREFERENCE_AUTHORITY: test("binding", "Pre-PostgreSQL preference authority; bound only by test configs."),
  RELAY_TRACE_ACCESS_AUTHORITY: test("binding", "Pre-PostgreSQL Trace grant authority; bound only by test configs."),
  RELAY_TRACE_ACCESS_LOCATOR: test("binding", "Pre-PostgreSQL Trace grant locator; bound only by test configs."),
  RELAY_TRACE_ACCESS_USER_INDEX: test("binding", "Pre-PostgreSQL Trace grant index; bound only by test configs."),
  RELAY_CONTROL_PLANE_DIRECTORY: retired,
  RELAY_RANK_AUTHORITY_DIRECTORY: retired,
  RELAY_GLOBAL_DIRECTORY_AUTHORITY: retired,
  RELAY_AGENT_APP_POLICY_AUTHORITY: test("binding", "Pre-PostgreSQL Agent/App policy authority; bound only by test configs."),
  RELAY_AGENT_APP_POLICY_LOCATOR: retired,
  RELAY_SPACE_PROJECTION: retired,
  RELAY_SPACE_CAPACITY_AUTHORITY: retired,
  RELAY_SPACE_ROOT_AUTHORITY: test("binding", "Pre-PostgreSQL Space root authority; bound only by test configs."),
  RELAY_RUNTIME: product("binding", "Runtime cells holding live Agent and client connections."),
  RELAY_RUNTIME_ROUTE_DIRECTORY: product("binding", "Runtime delivery-scope to cell directory."),
  RELAY_RUNTIME_CHANNEL_FANOUT: product("binding", "Per-channel runtime fanout once a channel outgrows the direct cell list."),
  DEVICE_AUTH: product("binding", "Device-code login broker for the CLI and apps."),

  // PostgreSQL.
  RELAY_POSTGRES: { kind: "binding", scope: "required", summary: "Hyperdrive binding to the primary PostgreSQL database (profile `hub.hyperdrive`). Every product authority reads and writes it." },
  RELAY_POSTGRES_SHARD_ID: product("var", "Shard id the primary database serves (`shard-0`)."),
  RELAY_POSTGRES_SHARD_1: { kind: "binding", scope: "feature", summary: "Hyperdrive binding to a second database shard. Unset: every Space is placed on the primary shard." },
  RELAY_POSTGRES_SHARD_1_ID: { kind: "var", scope: "feature", summary: "Shard id served by RELAY_POSTGRES_SHARD_1; set with it in the deployment profile." },
  RELAY_POSTGRES_SHARD_2: { kind: "binding", scope: "feature", summary: "Optional further database shard." },
  RELAY_POSTGRES_SHARD_2_ID: { kind: "var", scope: "feature", summary: "Shard id served by RELAY_POSTGRES_SHARD_2." },
  RELAY_POSTGRES_SHARD_3: { kind: "binding", scope: "feature", summary: "Optional further database shard." },
  RELAY_POSTGRES_SHARD_3_ID: { kind: "var", scope: "feature", summary: "Shard id served by RELAY_POSTGRES_SHARD_3." },
  RELAY_POSTGRES_SHARD_4: { kind: "binding", scope: "feature", summary: "Optional further database shard." },
  RELAY_POSTGRES_SHARD_4_ID: { kind: "var", scope: "feature", summary: "Shard id served by RELAY_POSTGRES_SHARD_4." },
  POSTGRES_BACKGROUND_PASS_LIMIT: tuning("Concurrent background passes per shard (default 8)."),
  POSTGRES_BACKGROUND_ADMISSION_STRIPES: tuning("Permit stripes per shard (default 4)."),

  // Authority selectors and PostgreSQL-migration controls.
  AUTH_AUTHORITY: authority("accounts and sessions"),
  MACHINE_NAME_REQUIRED: product("var", "Require a recorded owner-chosen Machine name before enrollment, connect or recovery; production pins true."),

  // Product behavior pinned by the committed config.
  RELAY_AUTOMATION_EXECUTION_ENABLED: product("var", "Runs Automation occurrences; off when unset."),
  RELAY_AUTOMATION_RUN_TIMEOUT_MS: product("var", "Default deadline for Automation runs without their own timeout."),
  CLIENT_COMPATIBILITY_LEGACY_ADMISSION_ENABLED: product("var", "Admits the last client generation that sends no compatibility identity."),
  GITHUB_REPOSITORY_TOKEN_LEGACY_UNBOUND_ENABLED: product("var", "Mints repository tokens for daemons that name no Run (pre-binding CLI); refused unless \"true\"."),
  XMATRIX_RUNTIME_CELL_MODE: product("var", "Runtime cell routing; \"dual\" activates candidate cells."),

  // Storage, queues and platform bindings.
  RELAY_R2_CAPABILITY_HMAC_SECRET: { kind: "secret", scope: "required", summary: "Signs short-lived R2 capability URLs for attachments and history (at least 32 bytes). Unset or shorter: those routes answer 503 `capability_security_unavailable`." },
  RELAY_PAYLOAD_BUCKET: product("binding", "R2 bucket for message payloads and projections."),
  AUTH_DB: test("binding", "D1 auth database of the pre-PostgreSQL test configs."),
  ATTACHMENT_BUCKET: product("binding", "R2 bucket for attachments and avatars."),
  DIAGNOSTICS_AE: { kind: "binding", scope: "feature", summary: "Analytics Engine dataset for client diagnostics. Unset: diagnostics are dropped." },
  RELAY_AUTHORITY_OBSERVABILITY_AE: { kind: "binding", scope: "feature", summary: "Analytics Engine dataset for authority and PostgreSQL timing. Unset: observation is off." },
  RATE_LIMIT_CREDENTIAL: { kind: "binding", scope: "feature", summary: "Workers Rate Limiting allowance per bearer credential. Unset: credentialed requests are not counted." },
  RATE_LIMIT_ANONYMOUS: { kind: "binding", scope: "feature", summary: "Workers Rate Limiting allowance per client IP for requests without a credential. Unset: they are not counted." },
  RATE_LIMIT_HUMAN_CONNECT: { kind: "binding", scope: "feature", summary: "Workers Rate Limiting allowance of Human socket sign-ins per user. Unset: sign-ins are not counted." },
  RATE_LIMIT_ENFORCED: product("var", "Refuses over-limit requests with 429 and Retry-After only when \"true\"; otherwise they are only logged."),
  RELAY_AUTHORITY_OBSERVABILITY_ENABLED: product("var", "Writes authority observation only when \"true\"."),
  RELAY_AUTHORITY_OBSERVABILITY_SLOW_MS: tuning("Requests at or above this wall time are never sampled away."),
  POSTGRES_COORDINATION_OBSERVABILITY_SAMPLE_RATE: tuning("1-in-N sampling of message coordination summaries."),
  POSTGRES_QUERY_OBSERVABILITY_SAMPLE_RATE: tuning("1-in-N sampling of successful query points (default 10)."),
  POSTGRES_SESSION_OBSERVABILITY_SAMPLE_RATE: tuning("1-in-N sampling of successful session points (default 1)."),
  CF_VERSION_METADATA: product("binding", "Worker version metadata reported by health and diagnostics."),
  SEND_EMAIL: { kind: "binding", scope: "required", summary: "Cloudflare email binding that sends sign-in codes and invites. Unset: email sign-in and invites cannot be sent." },

  // Deployment identity and policy (deployment profile).
  APP_URL: { kind: "var", scope: "deployment", summary: "Web origin; rendered from the profile's `web.origin`. Unset: links, redirects and auth fail closed." },
  CONNECTOR_DINGTALK_COMPANY_CONFIG: { kind: "secret", scope: "feature", summary: "Verified company-console JSON: suite-ticket protocol, sync-http delivery, numeric suiteId, developerCorpId, appId and approved templateId/templateField. Requires complete native suite keys; unset keeps company routes and actions unavailable." },
  HUB_URL: { kind: "var", scope: "deployment", summary: "Hub origin and token issuer; rendered from the profile's `hub.origin`. Unset: authentication fails closed." },
  XMATRIX_RUNTIME_LOCATION_HINT: { kind: "var", scope: "deployment", summary: "Durable Object location hint (e.g. `apac`) for Runtime cells, which must sit next to PostgreSQL. Unset: cells are created near their first caller." },
  AUTH_COOKIE_DOMAIN: { kind: "var", scope: "deployment", summary: "Shared cookie domain for the Web and Hub origins (e.g. `.example.com`). Unset: cookies stay host-only, which suits localhost only." },
  AUTH_COOKIE_PREFIX: { kind: "var", scope: "deployment", summary: "Cookie name prefix, for a deployment nested under another's cookie domain." },
  XMATRIX_EMAIL_FROM: { kind: "var", scope: "deployment", summary: "Sender address for sign-in mail; defaults to `noreply@` the Web origin's host." },
  XMATRIX_INVITE_EMAIL_FROM: { kind: "var", scope: "deployment", summary: "Sender address for invites; defaults to XMATRIX_EMAIL_FROM." },
  PLATFORM_ADMIN_EMAILS: { kind: "var", scope: "deployment", summary: "Operator emails allowed to read the platform overview." },
  PLATFORM_ADMIN_SPACE_ID: { kind: "var", scope: "deployment", summary: "Space whose members are platform admins. Optional." },
  TEST_ENVIRONMENT_ACCESS_SPACE_ID: operator("var", "Space whose members may switch to the hosted Test deployment; leave unset."),

  // Authentication.
  BETTER_AUTH_SECRET: { kind: "secret", scope: "required", summary: "Signs sessions and tokens. Unset: the Hub cannot authenticate anyone." },
  BETTER_AUTH_JWKS_URL: tuning("JWKS URL for verifying session tokens; defaults to the Hub's own."),
  DIAGNOSTICS_HASH_SECRET: { kind: "secret", scope: "feature", summary: "Key that pseudonymizes users in diagnostics; defaults to BETTER_AUTH_SECRET." },
  GOOGLE_CLIENT_ID: { kind: "secret", scope: "feature", summary: "Google OAuth client id. Unset with its secret: Google sign-in is hidden." },
  GOOGLE_CLIENT_SECRET: { kind: "secret", scope: "feature", summary: "Google OAuth client secret." },
  XMATRIX_SECRET_CATALOG_KEY: { kind: "secret", scope: "required", summary: "Encrypts Space secrets (at least 32 characters). Unset: Space secrets cannot be stored or read." },

  // Optional integrations.
  STRIPE_SECRET_KEY: { kind: "secret", scope: "feature", summary: "Stripe API key for paid plans. Unset with the webhook secret: checkout and the billing portal answer 503." },
  STRIPE_WEBHOOK_SECRET: { kind: "secret", scope: "feature", summary: "Stripe webhook signing secret." },
  STRIPE_PRO_MONTHLY_PRICE_ID: { kind: "var", scope: "feature", summary: "Stripe price for the monthly Pro seat." },
  STRIPE_PRO_ANNUAL_PRICE_ID: { kind: "var", scope: "feature", summary: "Stripe price for the annual Pro seat." },
  JEV_AI_GATEWAY_API_KEY: { kind: "secret", scope: "feature", summary: "Vercel AI Gateway key for Jev, the model that picks which Agent answers. Unset: message-triggered launches run without Jev's choice, while launches that need a choice (registration input dispatch) answer 503 `registration_selection_unconfigured`." },
  SLACK_CLIENT_ID: { kind: "secret", scope: "feature", summary: "Slack OAuth client id for the Slack connector. Unset: the Slack connector cannot be connected." },
  SLACK_CLIENT_SECRET: { kind: "secret", scope: "feature", summary: "Slack OAuth client secret." },
  GITHUB_APP_ID: { kind: "var", scope: "feature", summary: "GitHub App id for the Space GitHub connection. Unset with the other GITHUB_APP_* values: Spaces cannot connect GitHub." },
  GITHUB_APP_CLIENT_ID: { kind: "var", scope: "feature", summary: "GitHub App OAuth client id. Unset: GitHub Connect reads it from GitHub for the App; Better Auth account linking stays off." },
  GITHUB_APP_CLIENT_SECRET: { kind: "secret", scope: "feature", summary: "GitHub App OAuth client secret." },
  GITHUB_APP_PRIVATE_KEY: { kind: "secret", scope: "feature", summary: "GitHub App private key (PEM)." },
  GITHUB_APP_SLUG: { kind: "var", scope: "feature", summary: "GitHub App slug used for install links." },
  GITHUB_WEBHOOK_SECRET: { kind: "secret", scope: "feature", summary: "GitHub App webhook signing secret." },
  GITHUB_API_BASE_URL: tuning("GitHub API origin (default https://api.github.com), for GitHub Enterprise."),

  // Official hosted operations.
  XMATRIX_ADMIN_TOKEN: operator("secret", "Legacy internal admin bearer."),
  CONTROL_PLANE_OPERATOR_TOKEN: operator("secret", "Machine credential for control-plane partition operator routes."),

  // Local and test deployments.
  XMATRIX_MOCK_AUTH_TOKEN: test("secret", "Bearer token that signs in the mock user; never set in production."),
  XMATRIX_MOCK_SCHEDULE_DELAY_MS: test("var", "Automation cadence seed honored only with mock auth."),
  XMATRIX_MOCK_AUTH_USERS: test("var", "JSON map of mock tokens to users."),
  XMATRIX_MOCK_AUTH_USER_ID: test("var", "Mock user id."),
  XMATRIX_MOCK_AUTH_EMAIL: test("var", "Mock user email."),
  XMATRIX_MOCK_AUTH_NAME: test("var", "Mock user name."),
  XMATRIX_MOCK_AUTH_AVATAR_URL: test("var", "Mock user avatar URL."),
} as const satisfies Record<keyof Env, HubEnvironmentEntry>;
