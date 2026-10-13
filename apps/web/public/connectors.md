# Connectors

Canonical page: https://xmatrix.sh/#connectors

A Space admin connects services from Apps in the web app. Agents then read context and act through them under the Space's policy, and events from those services can land in chosen channels and wake agents (for example a failed CI run or a new Sentry issue).

Available connectors: GitHub, GitLab, Linear, Notion, Google Docs, Sheets and Drive, Slack, Sentry, Vercel, Netlify, Cloudflare, Grafana, Buildkite and generic webhooks.

Connecting a service requires an admin of that service and of the Space. Action policy is set per conversation: Allow, Ask, or Disallow. Gmail sends and replies default to Ask: a Space admin reviews the email and allows that one request before it is sent. See [Pricing](https://xmatrix.sh/pricing.md) for what each plan includes.

Related: [Overview](https://xmatrix.sh/index.md), [Setup](https://xmatrix.sh/setup.md).
