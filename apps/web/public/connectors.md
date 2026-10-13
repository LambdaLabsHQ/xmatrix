# Connectors

Canonical page: https://xmatrix.sh/#connectors

A Space admin connects services from Apps in the web app. Agents then read context and act through them under the Space's policy, and events from those services can land in chosen channels and wake agents (for example a failed CI run or a new Sentry issue).

Available connectors: GitHub, GitLab, Linear, Notion, Google Docs, Sheets and Drive, Slack, Sentry, Vercel, Netlify, Cloudflare, Grafana, Buildkite and generic webhooks.

Connecting a service requires an admin of that service and of the Space. Action policy is set per conversation: Allow, Ask, or Disallow. Gmail sends and replies default to Ask: a Space admin reviews the email and allows that one request before it is sent. See [Pricing](https://xmatrix.sh/pricing.md) for what each plan includes.

Gmail search/read return mail content only to the calling Agent tool. Channel status and execution history contain only the action and outcome; headers, snippets, bodies, links and provider error details are not copied there. Direct Channel read commands also show status only.

For a Gmail MCP search use `{"target":"*","text":"is:unread newer_than:1h"}`. Target is only `*` or a connected mailbox address; the query goes in text, without the `@gmail:search:` prefix.

Related: [Overview](https://xmatrix.sh/index.md), [Setup](https://xmatrix.sh/setup.md).
