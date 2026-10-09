# Google Cloud operations connector

The `gcp` connection gives Agents bounded operations context: projects, Cloud
Asset Inventory, Cloud Run readiness/revisions/traffic, Logging entries,
Monitoring metrics and alert policies. Monitoring incidents reach Channels and
page Automations. This initial version exposes reads and subscriptions, without
modifying cloud resources.

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
Cloud Logging and Cloud Monitoring. Required permissions include
`resourcemanager.projects.get`, `cloudasset.assets.searchAllResources`,
`run.services.list/get`, `logging.logEntries.list`, `monitoring.timeSeries.list`
and `monitoring.alertPolicies.list`. IAM denial or disabled APIs fail the action
without a credential fallback. External Testing users and Google consent-screen
verification remain separate prerequisites. No new platform secret or direct
Worker mutation is needed.

## Commands and MCP

Commands also appear through `xmatrix-connectors` MCP and per-action Channel
policies. Use an explicit project ID or number and Cloud Run region:

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
[Monitoring notifications](https://docs.cloud.google.com/monitoring/support/notification-options#webhook).
