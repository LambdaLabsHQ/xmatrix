# Connectors

Canonical page: https://xmatrix.sh/#connectors

A Space admin connects services from Apps in the web app. Agents then read context and act through them under the Space's policy, and events from those services can land in chosen channels and wake agents (for example a failed CI run or a new Sentry issue).

Available connectors include GitHub, GitLab, Linear, Notion, Google Docs, Sheets and Drive, Google Ads, Google Analytics, Search Console, Slack, Sentry, Vercel, Netlify, Cloudflare, Grafana, Buildkite and generic webhooks. Provider registration, a production release and actual native acceptance are separate: a listed connector still needs a valid connection and the provider's own permissions.

Connecting a service requires an admin of that service and of the Space. Action policy is set per conversation: Allow, Ask, or Disallow. Gmail sends and replies default to Ask: a Space admin reviews the email and allows that one request before it is sent. See [Pricing](https://xmatrix.sh/pricing.md) for what each plan includes.

Gmail search/read return mail content only to the calling Agent tool. Channel status and execution history contain only the action and outcome; headers, snippets, bodies, links and provider error details are not copied there. Direct Channel read commands also show status only.

For a Gmail MCP search use `{"target":"*","text":"is:unread newer_than:1h"}`. Target is only `*` or a connected mailbox address; the query goes in text, without the `@gmail:search:` prefix.

Google Ads (`googleads`) uses its own Google `adwords` OAuth grant and one advertiser customer ID saved in Apps → Credentials. `list_accounts` lists directly accessible IDs; `read_account` confirms the selected advertiser/currency/time zone; `query` reads a SELECT GAQL report with at most 250 rows. `validate_mutations` validates Google advertising configuration without changing it. `mutate` atomically creates or updates campaigns, budgets, creatives and targeting, with new campaigns paused. `set_campaign_status` pauses or enables a campaign. Both write actions default to Ask; a Human Space admin may configure their Channel policy.

For a Google Ads MCP query, use `{"target":"1234567890","text":"SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_7_DAYS LIMIT 50"}`. Micros are integer millionths of the selected account's currency and dates use that account's time zone. Activation requires explicit currency and the current non-shared average daily budget; average budgets are not hard daily spending caps. An unconfirmed write is never automatically retried. Google ad review/serving is asynchronous, so API acceptance does not prove impressions. The company OAuth client's Cloud project needs Google Ads API Explorer access or higher; developer tokens were retired in September 2026. See the [authoritative Google Ads connector contract](https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/connectors/google-ads.md) and [user guide](https://xmatrix.sh/docs/connectors#managing-google-ads).

Related: [Overview](https://xmatrix.sh/index.md), [Setup](https://xmatrix.sh/setup.md).
