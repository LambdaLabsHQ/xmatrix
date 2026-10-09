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
Monitoring APIs are supported. It does not alter IAM bindings or create billable resources.
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
