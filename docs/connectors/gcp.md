# Google Cloud operations connector

The `gcp` connection gives Agents bounded operations context: projects, Cloud
Asset Inventory, Cloud Run readiness/revisions/traffic, Logging entries,
Monitoring metrics and alert policies, plus billing account/export discovery
and cost analysis. Monitoring incidents reach Channels and page Automations.
Resource data actions are reads; creating a temporary cost report and enabling
a supported API are separate policy-controlled writes.

## Connect

A Human Space admin selects **Connect with Google Cloud** in Apps. GCP reuses
the company `CONNECTOR_GOOGLE_CLIENT_ID` / `CONNECTOR_GOOGLE_CLIENT_SECRET`
and the existing callback, but holds its own encrypted connection and token.
Drive, Search Console and AdSense tokens are not reused. Authorization requests
offline access, explicit consent, no incremental scope union, and exactly
`https://www.googleapis.com/auth/cloud-platform`. Exchange and refresh reject
different or additional scopes. Unrotated refresh tokens remain in the store.

Cloud Run v2 requires the broad `cloud-platform` scope even for reads. It is
not a read-only OAuth permission; the connector's exposed actions are reads,
and Google IAM independently limits each request. Connect an account with only
the project permissions it needs. Check performs a real Resource Manager
project search. A successful empty list means no projects are visible, not that
every resource API is enabled or authorized.

Enable the relevant APIs in the company OAuth project and, where Google requires
it, target projects: Cloud Resource Manager, Cloud Asset, Cloud Run Admin,
Cloud Logging, Cloud Monitoring, Cloud Billing, BigQuery, App Optimize and Service Usage. Required permissions include
`resourcemanager.projects.get`, `cloudasset.assets.searchAllResources`,
`run.services.list/get`, `logging.logEntries.list`, `monitoring.timeSeries.list`
and `monitoring.alertPolicies.list`. Billing metadata uses
`billing.accounts.list` and project billing access; export discovery/analysis
needs `bigquery.datasets.get`, `bigquery.tables.list/getData` and
`bigquery.jobs.create` on the query project. API enablement needs
`serviceusage.services.enable`, independently of OAuth consent. IAM denial or disabled APIs fail the action
without a credential fallback. External Testing users and Google consent-screen
verification remain separate prerequisites. No new platform secret or direct
Worker mutation is needed.

## Commands and MCP

Commands also appear through `xmatrix-connectors` MCP and per-action Channel
policies. Use an explicit project ID or number and Cloud Run region:

Region numbers can have two digits, such as `europe-west10` and `europe-west12`.
Zones, wildcards and paths are not region names. See
[Cloud Run locations](https://docs.cloud.google.com/run/docs/locations).

```text
@gcp:list_projects:*
@gcp:list_resources:my-project
@gcp:list_services:my-project/us-central1
@gcp:read_service:my-project/us-central1/web
@gcp:query_logs:my-project {"minutes":60,"severity":"ERROR","service":"web","text":"timeout"}
@gcp:query_metrics:my-project {"metric":"compute.googleapis.com/instance/cpu/utilization","minutes":60}
@gcp:list_alert_policies:my-project
```

Lists return the first page, up to 30 items, and mark pagination/truncation.
Output is bounded and quoted as untrusted content. Cloud Run reads omit
container environments, service identities and credential configuration.
Log queries use a fixed project, newest-first order and a recent time interval.
`minutes` defaults to 60 and is bounded to 1–10080; severity is a Google
severity, service selects Cloud Run revision logs, and text is a quoted `SEARCH`
literal. Arbitrary Logging filters are not accepted. Metrics require one
metric type and the same bounded interval; they show only the newest returned
point per returned series with resource/metric labels. These are samples, not
complete exports or aggregate reports.

## Billing and cost analysis

### Direct project cost reports (App Optimize)

App Optimize provides project cost reports directly from Google's billing
cost data. It does not require a pre-existing BigQuery billing export. Reports
are automatically deleted after 24 hours; during Preview, generating/reading
reports has no additional App Optimize fee. Its data normally lags usage by a
day and can lag longer. Costs are gross contract-price usage costs **before
credits**, not a final invoice or after-credit bill.

```text
@gcp:create_cost_report:my-project {"from":"2026-09-01T00:00:00Z","to":"2026-10-01T00:00:00Z","groupBy":"product"}
@gcp:read_cost_operation:my-project/<operation-id>
@gcp:read_cost_report:my-project/<report-id>
```

Report creation is a declared write of a temporary report resource. It needs
`appoptimize.reports.create` (App Optimize Admin) and `billing.resourceCosts.get`
(e.g. Viewer) on the scoped project. Reading needs the report get/getData and
operation get permissions. `cloud-platform` already authorizes these calls.
Enable `appoptimize.googleapis.com` using `enable_api` if needed.

The scope is exactly the target project, location `global`, metrics only `cost`.
No arbitrary CEL/filter is accepted. `from`/`to` are UTC RFC3339 timestamps,
`to` exclusive, and the start must be in the last 90 days. `groupBy` is `total`,
`product`, `month`, `month_product`, `day` or `sku` and maps to a supported
dimension combination. Time dimensions use Pacific Time and the provider can
expand the interval to whole periods; use `total`/`product` for a precise
interval without time-dimension expansion. `reportId` is optional and can make
an explicitly retried creation addressable without creating another ID.

Reads verify the report's project scope and cost-only metrics, render exact
currency units/nanos without floating-point rounding, and preserve the actual
filter/expiry. Each page is capped at 30 rows. Continue with the returned
`pageToken`; a partial page is not a project total, and an empty report does not
prove zero spend. Reports can be reused by their IDs until expiry.

### Exported credits and net costs (BigQuery)

Cloud Billing account/catalog APIs describe accounts, linkage and prices; they
are not a project-spend report. Actual exported usage/cost analysis uses an
existing **standard or detailed Cloud Billing export to BigQuery**. The export
may live in a central billing project rather than the workload project.
Connecting Google Cloud does not create an export or backfill missing history.
No additional OAuth scope is needed: the independent `cloud-platform` grant
covers Billing, BigQuery and Service Usage; Google IAM remains authoritative.

```text
@gcp:list_billing_accounts:*
@gcp:read_billing_info:my-project
@gcp:list_datasets:billing-project
@gcp:list_billing_tables:billing-project/billing_export
@gcp:query_costs:billing-project/billing_export/gcp_billing_export_v1_ABCDEF_123456_AB1234 {"project":"my-project","location":"US","from":"2026-09-01","to":"2026-11-01","groupBy":"month_service","dryRun":true}
```

Dataset and table discovery is one bounded page per call. Pass the returned
`pageToken` in JSON options to continue; an empty page does not establish that
no export exists. Discovery shows only standard/detailed export table names,
not ordinary tables. FOCUS exports have another schema and are not queried by
this action. Use the dataset's reported location.

`query_costs` uses fixed GoogleSQL and named parameters, never caller-authored
SQL, wildcard tables or output destinations. The billed project must be its
ID, even if the export/query project is specified by number. `from` is inclusive,
`to` exclusive, each is YYYY-MM-DD, and the interval is at most 366 days. Defaults
cover last month and this month, by usage date in UTC. `timezone` accepts an
IANA time zone; `groupBy` is `month`, `day`, `service`, `sku` or `month_service`.

A dry run is the default and returns estimated scanned bytes, **not costs**.
Set `dryRun:false` to read actual export totals; BigQuery query charges can apply.
Every query has `maximumBytesBilled` (default 100,000,000, maximum 1,000,000,000),
uses the query cache, and has a bounded request/job timeout. A query exceeding
its billing cap fails without a query charge. A pending query returns its job
ID: repeat the same command/options with `dryRun:false` and `job:<id>` to fetch
that job rather than submit another query. The executor checks the stored
SQL and all parameters against the requested report before reading results.

The report retains decimal cost, credits and net cost, separately by currency.
Credits are summed without multiplying cost rows. Currency totals include all
groups; only the first 30 groups are displayed, ordered by net cost. The report
names the latest exported record and usage end time, warns about late data,
and never describes an empty export as zero spend. These are exported
usage-date totals, not forecasts or a promise to match invoice/tax totals.

### API and IAM failures

Google errors return typed reasons and, when available, the API, consumer
project number and missing permission. Raw provider bodies/tokens are omitted.
`SERVICE_DISABLED` identifies which project's API enablement is required; it
is not a missing OAuth scope. Check or enable a supported API through Connector:

```text
@gcp:read_api_status:123456789/bigquery.googleapis.com
@gcp:enable_api:123456789/bigquery.googleapis.com
```

`enable_api` is a declared write, uses the Channel's action policy and Google
IAM, and returns an operation receipt; use `read_api_status` until `ENABLED`.
Use the numeric project number (returned by `list_projects` or the Google
error consumer). Only App Optimize, Billing, BigQuery, Asset, Resource Manager, Run, Logging and
Monitoring and API Keys APIs are supported. It does not alter IAM bindings or create billable resources.
IAM denial requires the resource owner to grant the actual missing permission;
a wider OAuth consent cannot override it.

## Monitoring notifications

In Apps, generate the connection's ingress URL and **Monitoring webhook token**.
In the metrics-scope project, create a Cloud Monitoring webhook notification
channel whose URL is the ingress URL with `?auth_token=<token>` appended.
Keep this full URL private. Attach the channel to the desired alert policies
and enable incident-closure notifications where needed. xMatrix does not
create or alter GCP notification channels or alert policies.

```text
@gcp:subscribe:my-project fired resolved
```

The source is `incident.scoping_project_id`, not the monitored resource's
project: a metrics scope can monitor other projects. `*` receives all projects
whose notifications reach this connection. Automations use
`--on gcp:fired:my-project` or `--on gcp:resolved:my-project`.

Ingress validates the connection key and shared token before parsing schema 1.2.
Missing identities, unsupported versions/states and invalid timestamps fail
closed. Open and closed edges have distinct stable event IDs; retries and
repeated open reminders dedupe to the same edge. Rotation/reconnect requires
updating the GCP destination to the current ingress and token. Shared-token
authentication proves possession of the destination secret; Google does not
sign these payloads. Notification contents do not authorize operations.

## Acceptance

After the normal Hub/Web release, verify real OAuth, Check, resource/log/metric
reads under the intended IAM grant, denied Channel policy, and permission/API
errors. Trigger and close a real Monitoring incident; verify metrics-scope
routing, duplicate suppression and Automation delivery. Verify wrong tokens,
OAuth revocation, rotation and reconnect. Fixtures and a deployed manifest are
implementation evidence, not native provider acceptance.

References: [project search](https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects/search),
[resource search](https://docs.cloud.google.com/asset-inventory/docs/reference/rest/v1/TopLevel/searchAllResources),
[Cloud Run services](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services),
[Logging entries](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/entries/list),
[Monitoring time series](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.timeSeries/list),
[Monitoring notifications](https://docs.cloud.google.com/monitoring/support/notification-options#webhook),
[Cloud Billing APIs](https://docs.cloud.google.com/billing/docs/reference/rest),
[billing export](https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery),
[export cost/credit queries](https://docs.cloud.google.com/billing/docs/how-to/bq-examples),
[BigQuery queries](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query),
[Service Usage enable](https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services/enable),
[App Optimize reports](https://docs.cloud.google.com/app-optimize/create-read-report),
[App Optimize data semantics](https://docs.cloud.google.com/app-optimize/optimization-data),
[App Optimize pricing](https://docs.cloud.google.com/app-optimize/overview#pricing).

## Cost attribution and quota projects

A cost report's SKU resource identifies a billable item, not its model or
input/output description. Resolve that exact ID through the connected provider:

```text
@gcp:read_sku:my-project/ABCD-1234-5678
@gcp:query_api_usage:my-project {"from":"2026-09-01T00:00:00Z","to":"2026-10-01T00:00:00Z","apiService":"generativelanguage.googleapis.com","responseClass":"all"}
@gcp:read_billing_info:my-project {"quotaProject":"my-project"}
@gcp:list_billing_accounts:* {"quotaProject":"my-project"}
```

`read_sku` reads public SKU metadata through Cloud Billing v2beta, with no
price or usage inference. `query_api_usage` requires a project ID and filters the monitored resource to
that exact project, even when its metrics scope includes other projects. It uses the fixed Service Runtime
request-count metric, ALIGN_SUM and cross-series REDUCE_SUM, daily by default. API service
is limited to Gemini (`generativelanguage.googleapis.com`), Vertex AI
(`aiplatform.googleapis.com`) or Cloud Run (`run.googleapis.com`); responseClass
is all, 2xx, 4xx or 5xx. Optional `groupBy` is `day` (default), `credential`
or `credential_method`. Credential grouping sums over the selected interval,
retaining only fixed credential/method labels; arbitrary grouping or filters
are refused. UTC timestamps must describe a completed interval of
at most 31 days within the past 90 days. Results expose at most 30
points and a bounded pageToken continuation; empty or partial results do not
prove zero requests or complete totals. These are API calls, not token usage
or per-user attribution. Returned UTC intervals differ from Pacific billing
days; preserve that distinction when comparing spikes.

These two new reads explicitly use the named project as the quota project
via `x-goog-user-project`. The existing billing metadata reads retain their
previous behavior unless quotaProject is explicitly provided. For project
billing linkage it must match the target; account discovery accepts a named
project. The same encrypted OAuth grant authenticates every call. Google
requires `serviceusage.services.use` and an enabled API on the quota project;
this supplies quota context, never resource authorization, an IAM grant or
a credential fallback. It avoids coupling a user's project queries to API
activation on the company's OAuth client project. Enable the corresponding
Cloud Billing/Monitoring API on that quota project before retrying.

References: [public SKU metadata](https://docs.cloud.google.com/billing/docs/reference/pricing-api/rest/v2beta/skus/get),
[quota project selection](https://docs.cloud.google.com/docs/quotas/set-quota-project),
and [Monitoring aggregation](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.timeSeries/list).

## Caller attribution

```text
@gcp:query_api_usage:my-project {"from":"2026-09-01T00:00:00Z","to":"2026-10-01T00:00:00Z","groupBy":"credential_method"}
@gcp:list_api_keys:123456789 {"showDeleted":true}
@gcp:query_audit_activity:my-project {"from":"2026-09-01T00:00:00Z","to":"2026-10-01T00:00:00Z","service":"apikeys.googleapis.com"}
```

Credential-grouped Service Runtime counts identify recorded API key IDs or
OAuth client IDs and, optionally, API methods. They do not identify people,
programs, model names, tokens or per-key costs. Preserve returned UTC intervals
and follow all bounded pageToken continuations before comparing their sum to
an all-credential report. The same project filter prevents a shared metrics
scope from including another project. Empty data is not proof of no use.

`list_api_keys` requires the numeric project number and `apikeys.keys.list`.
It calls only API Keys v2 ListKeys, never GetKeyString or LookupKey. The report
includes exact-project key resource/UUID, mutable display name, creation/deletion
timestamps, optional bound service account, API service restrictions and client
restriction types. Secret key values, annotations, detailed client addresses
and arbitrary metadata are omitted. `showDeleted` is false by default; Google's
API retains deleted keys for only 30 days. Key metadata cannot establish a
creation actor or who used a shared key. Enable `apikeys.googleapis.com` through
the separate typed `enable_api` action if needed; no IAM, key or restriction
mutation is exposed. These reads use the same OAuth identity and named quota project.

`query_audit_activity` uses a fixed project, explicit completed UTC interval
(up to 31 days within 400 days), newest-first bounded paging, the AuditLog payload
type and exactly one allowed service: Gemini API or API Keys. It emits only
principal email/subject, time, method, status and a syntactically valid key
resource, omitting request/response bodies, key values, source IP and user agent.
It accepts no caller-authored Logging filter. API-key CreateKey/UpdateKey actors
are administrators, not necessarily inference callers. Data Access logs must
have been enabled, retained and readable (`logging.privateLogEntries.list`);
no returned entries do not prove no traffic. These reads do not enable audit
logging, create sinks, grant IAM or reconstruct absent history.

References: [consumed API credential labels](https://docs.cloud.google.com/monitoring/api/resources#tag_consumed_api),
[Google's key-usage correlation example](https://codelabs.developers.google.com/api-key-management#4),
[secret-free ListKeys](https://docs.cloud.google.com/api-keys/docs/reference/rest/v2/projects.locations.keys/list),
[key metadata](https://docs.cloud.google.com/api-keys/docs/reference/rest/v2/projects.locations.keys),
and [API Keys audit methods](https://docs.cloud.google.com/api-keys/docs/audit-logging).
