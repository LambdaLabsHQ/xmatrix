import type { RequestRateLimiter } from "./request-rate-limit";

export interface Env {
  /** Per-Space clock for PostgreSQL-owned decision retention. */
  RELAY_SUMMON_DECISION_CLOCK?: DurableObjectNamespace;
  /** Per-Space clock for PostgreSQL-owned Space deletion purges. */
  RELAY_SPACE_DELETION_CLOCK?: DurableObjectNamespace;
  /** One live co-editing session per page; PostgreSQL owns the committed page. */
  RELAY_PAGE_SESSION?: DurableObjectNamespace;
  /** Retired; a 410 shell kept bound over its historical rows. */
  RELAY_SCOPED_CONTROL_AUTHORITY: DurableObjectNamespace;
  /** Retired; a 410 shell kept bound over its historical rows. */
  RELAY_CHANNEL_FAMILY_DATA: DurableObjectNamespace;
  /** Retired; a 410 shell kept bound over its historical rows. */
  RELAY_CHANNEL_FAMILY_DIRECTORY: DurableObjectNamespace;
  /** Per-Channel sequence reservation/confirmation only; never stores message facts. */
  RELAY_POSTGRES_CHANNEL_COORDINATOR: DurableObjectNamespace;
  /** One global alarm/lease trigger for PostgreSQL billing notices; stores no product facts. */
  /** One global clock for PostgreSQL Automations; stores no product facts. */
  /** Global fact-free publisher for durable PostgreSQL Agent Launches. */
  /** One Agent Launch coordinator per Channel, addressed by Channel id. */
  RELAY_POSTGRES_AGENT_LAUNCH_CHANNEL?: DurableObjectNamespace;
  GITHUB_SUBSCRIPTION_INDEX?: DurableObjectNamespace<import("./github-subscription-index").GitHubSubscriptionIndex>;
  /** Per-shard permits bounding concurrent background passes; holds no work. */
  RELAY_POSTGRES_BACKGROUND_ADMISSION?: DurableObjectNamespace;
  /** Concurrent Channel coordinator passes admitted per PostgreSQL shard (default 8). */
  POSTGRES_BACKGROUND_PASS_LIMIT?: string;
  /** Permit stripes per shard (default 4); add stripes, not limit, as permit traffic grows. */
  POSTGRES_BACKGROUND_ADMISSION_STRIPES?: string;
  /** Dormant opaque-directory target for one Space's Channel catalog/tree. */
  RELAY_CHANNEL_CATALOG_AUTHORITY: DurableObjectNamespace;
  /** Dormant scoped target for scheduler-orchestration facts and local ledger state. */
  RELAY_SCHEDULER_AUTHORITY: DurableObjectNamespace;
  /** Dormant opaque-directory target for one projection-authorization shard. */
  RELAY_PROJECTION_AUTHORIZATION_AUTHORITY: DurableObjectNamespace;
  /** Dormant opaque-directory target for one Space's membership and ACL facts. */
  RELAY_SPACE_MEMBERSHIP_AUTHORITY: DurableObjectNamespace;
  /** Dormant opaque-directory target for one user's Space-presentation preferences. */
  RELAY_USER_PREFERENCE_AUTHORITY: DurableObjectNamespace;
  /** Dormant opaque-directory target for one fixed Trace-access grant shard. */
  RELAY_TRACE_ACCESS_AUTHORITY: DurableObjectNamespace;
  /** Product-inert opaque route for one Trace grant id. */
  RELAY_TRACE_ACCESS_LOCATOR: DurableObjectNamespace;
  /** Rebuildable user-scoped projection of Trace grant-list snapshots. */
  RELAY_TRACE_ACCESS_USER_INDEX: DurableObjectNamespace;
  /** Retired; a 410 shell kept bound over its historical rows. */
  RELAY_CONTROL_PLANE_DIRECTORY: DurableObjectNamespace;
  /** Retired; a 410 shell kept bound over its historical rows. */
  RELAY_RANK_AUTHORITY_DIRECTORY: DurableObjectNamespace;
  /** Retired; a 410 shell kept bound over its historical rows. */
  RELAY_GLOBAL_DIRECTORY_AUTHORITY: DurableObjectNamespace;
  /** Dormant opaque-directory target for one Space's Agent/App policy facts. */
  RELAY_AGENT_APP_POLICY_AUTHORITY: DurableObjectNamespace;
  /** Retired; a 410 shell kept bound over its historical rows. */
  RELAY_AGENT_APP_POLICY_LOCATOR: DurableObjectNamespace;
  /** Retired; a 410 shell kept bound over its historical rows. */
  RELAY_SPACE_PROJECTION: DurableObjectNamespace;
  /** Retired; a 410 shell kept bound over its historical rows. */
  RELAY_SPACE_CAPACITY_AUTHORITY: DurableObjectNamespace;
  /** Dormant opaque-directory target for one Space's root/config facts. */
  RELAY_SPACE_ROOT_AUTHORITY: DurableObjectNamespace;
  RELAY_RUNTIME: DurableObjectNamespace;
  /** Bounded, expiring Runtime delivery-scope to occupied-cell projection. */
  RELAY_RUNTIME_ROUTE_DIRECTORY: DurableObjectNamespace;
  /** Per-channel fanout once a channel outgrows the direct cell list. */
  RELAY_RUNTIME_CHANNEL_FANOUT?: DurableObjectNamespace;
  DEVICE_AUTH: DurableObjectNamespace;
  /** Optional until a reviewed Hyperdrive resource is provisioned; never enables routing by presence alone. */
  RELAY_POSTGRES?: Hyperdrive;
  /** Stable physical identity for RELAY_POSTGRES; selected placement must match it. */
  RELAY_POSTGRES_SHARD_ID?: string;
  /** Finite additional correctness bindings for placement-routed physical shards. */
  RELAY_POSTGRES_SHARD_1?: Hyperdrive;
  RELAY_POSTGRES_SHARD_1_ID?: string;
  RELAY_POSTGRES_SHARD_2?: Hyperdrive;
  RELAY_POSTGRES_SHARD_2_ID?: string;
  RELAY_POSTGRES_SHARD_3?: Hyperdrive;
  RELAY_POSTGRES_SHARD_3_ID?: string;
  RELAY_POSTGRES_SHARD_4?: Hyperdrive;
  RELAY_POSTGRES_SHARD_4_ID?: string;
  /** Domain authority selector. Unset/d1 preserves Main; postgres is fail-closed with no D1 fallback. */
  AUTH_AUTHORITY?: "d1" | "postgres";
  /** Enrollment requires an owner-chosen name; clients cannot override this gate. */
  MACHINE_NAME_REQUIRED?: string;
  /** Durable CORE_ACTIVE Automation occurrence execution. Defaults off. */
  RELAY_AUTOMATION_EXECUTION_ENABLED?: string;
  /** Legacy/default deadline for schedules without an Automation-level execution timeout. */
  RELAY_AUTOMATION_RUN_TIMEOUT_MS?: string;
  /**
   * Transitional admission for the last pre-identity client generation.
   * Only requests with no compatibility fields at all may enter this lane;
   * explicit invalid or obsolete identities remain rejected.
   */
  CLIENT_COMPATIBILITY_LEGACY_ADMISSION_ENABLED?: string;
  /**
   * Transitional: mint repository tokens for daemons that predate the Run
   * binding and name no Run. Retire once the minimum supported CLI sends it.
   */
  GITHUB_REPOSITORY_TOKEN_LEGACY_UNBOUND_ENABLED?: string;
  RELAY_R2_CAPABILITY_HMAC_SECRET?: string;
  RELAY_PAYLOAD_BUCKET?: R2Bucket;
  AUTH_DB?: D1Database;
  ATTACHMENT_BUCKET?: R2Bucket;
  DIAGNOSTICS_AE?: AnalyticsEngineDataset;
  /**
   * Relay authority phase observation. Deliberately a separate dataset from
   * DIAGNOSTICS_AE: that one indexes on a per-user hash, and mixing a
   * low-cardinality schema key into the same index would break both its cost
   * profile and its query contract. Absent binding means observation is off.
   */
  RELAY_AUTHORITY_OBSERVABILITY_AE?: AnalyticsEngineDataset;
  /** Per-credential request allowance (Workers Rate Limiting). Absent: unlimited. */
  RATE_LIMIT_CREDENTIAL?: RequestRateLimiter;
  /** Per-client-IP allowance for requests without a credential. */
  RATE_LIMIT_ANONYMOUS?: RequestRateLimiter;
  /** Per-user allowance of Human socket sign-ins. */
  RATE_LIMIT_HUMAN_CONNECT?: RequestRateLimiter;
  /** Over-limit requests are refused only when this is exactly "true"; otherwise only logged. */
  RATE_LIMIT_ENFORCED?: string;
  /** Observation writes only when this is exactly "true". */
  RELAY_AUTHORITY_OBSERVABILITY_ENABLED?: string;
  /** Requests at or above this wall time are never thinned. */
  RELAY_AUTHORITY_OBSERVABILITY_SLOW_MS?: string;
  /** Random 1-in-N sampling for PostgreSQL message coordination summaries. */
  POSTGRES_COORDINATION_OBSERVABILITY_SAMPLE_RATE?: string;
  /** Keep one in N ordinary successful PostgreSQL query points (default 10). */
  POSTGRES_QUERY_OBSERVABILITY_SAMPLE_RATE?: string;
  /** Keep one in N ordinary successful PostgreSQL session points (default 1). */
  POSTGRES_SESSION_OBSERVABILITY_SAMPLE_RATE?: string;
  /** Native version metadata; never synthesised when the binding is absent. */
  CF_VERSION_METADATA?: { id?: string; tag?: string };
  SEND_EMAIL?: SendEmail;
  APP_URL?: string;
  /** Verified console protocol/delivery/identifiers and approved template; absent keeps company installation closed. */
  CONNECTOR_DINGTALK_COMPANY_CONFIG?: string;
  /** Server-only Stripe API key. A public Payment Link is never an entitlement. */
  APPLE_SUBSCRIPTIONS_CONFIG?: string;
  PUSH_CONFIG?: string;
  STRIPE_SECRET_KEY?: string;
  /** Server-only signing secret for the exact Stripe webhook endpoint. */
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRO_MONTHLY_PRICE_ID?: string;
  STRIPE_PRO_ANNUAL_PRICE_ID?: string;
  /** Jev provider key remains inside the Worker; never returned to callers. */
  JEV_AI_GATEWAY_API_KEY?: string;
  /** Deployment-owned comma-separated Human ids allowed to use this key. */
  HUB_URL?: string;
  /**
   * Exact shared cookie suffix for APP_URL and HUB_URL. Production and hosted
   * test deployments must set this explicitly; local development stays
   * host-only when it is absent.
   */
  AUTH_COOKIE_DOMAIN?: string;
  /** Optional environment-specific Better Auth cookie namespace. */
  AUTH_COOKIE_PREFIX?: string;
  BETTER_AUTH_SECRET?: string;
  DIAGNOSTICS_HASH_SECRET?: string;
  BETTER_AUTH_JWKS_URL?: string;
  XMATRIX_EMAIL_FROM?: string;
  XMATRIX_INVITE_EMAIL_FROM?: string;
  XMATRIX_ADMIN_TOKEN?: string;
  /**
   * Comma/space separated operator emails allowed to read the platform admin
   * overview. Deployment-owned; the product never writes it.
   */
  PLATFORM_ADMIN_EMAILS?: string;
  /**
   * Space whose members are platform admins. The id is deployment-owned so no
   * Space can elect itself; membership is then maintained in-product.
   */
  PLATFORM_ADMIN_SPACE_ID?: string;
  /**
   * Deployment secret authorizing ONLY the control-plane partition operator
   * routes (status/begin/advance/fence/activate/backfill) for unattended
   * cutover execution. Absent or shorter than 32 bytes the machine path is
   * disabled and those routes require an interactive platform admin.
   */
  CONTROL_PLANE_OPERATOR_TOKEN?: string;
  /**
   * Production Space whose signed-in members may enter the hosted Test app.
   * The deployment pins the id; clients and Spaces cannot widen this grant.
   */
  TEST_ENVIRONMENT_ACCESS_SPACE_ID?: string;
  XMATRIX_MOCK_AUTH_TOKEN?: string;
  /** Runtime cell routing: exactly "dual" activates candidate cells; default shadow. */
  XMATRIX_RUNTIME_CELL_MODE?: string;
  XMATRIX_RUNTIME_LOCATION_HINT?: string;
  /** Test-only cadence seed; never honored without mock auth. */
  XMATRIX_MOCK_SCHEDULE_DELAY_MS?: string;
  XMATRIX_MOCK_AUTH_USERS?: string;
  XMATRIX_MOCK_AUTH_USER_ID?: string;
  XMATRIX_MOCK_AUTH_EMAIL?: string;
  XMATRIX_MOCK_AUTH_NAME?: string;
  XMATRIX_MOCK_AUTH_AVATAR_URL?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_API_BASE_URL?: string;
  XMATRIX_SECRET_CATALOG_KEY?: string;
}
