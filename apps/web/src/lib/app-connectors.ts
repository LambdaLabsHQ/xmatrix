import {
  APP_CONNECTOR_PROVIDER_MANIFESTS,
  type AppConnectorProviderManifest,
} from "@xmatrix/protocol";

export type AppConnectorManifest = AppConnectorProviderManifest & {
  agentUseCases: string[];
};

const AGENT_USE_CASES: Record<AppConnectorProviderManifest["id"], string[]> = {
  github: [
    "Dispatch issue triage to a channel-local agent instance.",
    "Keep PR review comments and CI failures attached to the same work session.",
    "Preserve GitHub tokens in secret stores instead of channel text.",
  ],
  webhook: [
    "Route deploy, CI, and monitor notifications into the channel where agents work.",
    "Wake a page Automation when an internal system reports an event.",
  ],
  sentry: [
    "Hand a new or regressed error to an agent in the channel that owns the service.",
    "Keep the alert, the fix, and the pull request in one conversation.",
  ],
  linear: [
    "Read a Linear issue's context, then create an issue or comment with the result.",
    "See status changes without leaving the conversation.",
  ],
  pagerduty: [
    "Open the incident conversation the moment PagerDuty triggers.",
    "Let agents gather context while humans acknowledge and resolve.",
  ],
  gitlab: [
    "Read a GitLab issue or merge request's context, then comment with the result.",
    "Hand a failed pipeline to an agent in the same channel.",
  ],
  slack: [
    "Let people stay in Slack while their messages reach the agents' channel.",
    "Bring a Slack thread's context to an agent without copy and paste.",
  ],
  jira: [
    "Pick up Jira issues and comments in the channel where agents work on them.",
  ],
  vercel: [
    "See failed and finished deployments where agents can act on them.",
  ],
  cloudflare: [
    "Wake agents when Cloudflare alerts fire, with Workers logs, deployments, and rollback at hand.",
  ],
  gcp: [
    "Investigate Google Cloud alerts using project resources, Cloud Run status, logs and metrics.",
    "Keep GCP credentials in the Space while IAM and channel policies control access.",
  ],
  feishu: [
    "Let people stay in Feishu while their messages reach the agents' channel.",
  ],
  discord: [
    "Post agent results and release notes into a Discord community channel.",
  ],
  notion: [
    "Read an authorized requirements page before writing a plan or results back.",
    "Let agents write findings and plans into Notion pages your team already reads.",
  ],
  google: [
    "Read table ranges and write structured results back as explicit RAW values.",
    "Read app-authorized Google Docs as task context.",
    "Create documents and append plans or results where your team works.",
    "Keep file access limited to documents created by or explicitly opened with xMatrix.",
  ],
  googlesearchconsole: [
    "Pull clicks, impressions, CTR and ranking for every site the connected Google account manages.",
    "Check a page's index status or submit a sitemap without opening Search Console.",
    "Run a scheduled Automation that reports search traffic changes into the channel.",
  ],
  googleadsense: [
    "Read daily AdSense earnings, page views and RPM by site, country or page.",
    "Let a scheduled Automation track each site's revenue next to its search traffic.",
  ],
  bitbucket: [
    "Follow Bitbucket pull requests and builds alongside agents.",
  ],
  circleci: [
    "Hand a failed CircleCI workflow to an agent in the same channel.",
  ],
  buildkite: [
    "Hand a failed Buildkite build to an agent in the same channel.",
  ],
  stripe: [
    "Route failed payments and disputes to the channel that handles them.",
  ],
  grafana: [
    "Open the conversation when a Grafana alert fires, and close the loop when it resolves.",
  ],
  opsgenie: [
    "Open the incident conversation when Opsgenie creates an alert.",
  ],
  netlify: [
    "See failed and finished Netlify deploys where agents can act on them.",
  ],
  telegram: [
    "Let people stay in Telegram while their messages reach the agents' channel.",
  ],
  teams: [
    "Post agent results into the Microsoft Teams channel people already watch.",
  ],
  googlechat: [
    "Post agent results into a Google Chat space.",
  ],
  dingtalk: [
    "Post agent results into a DingTalk group.",
  ],
  openconnector: [
    "Reach the long tail of SaaS actions through your own OpenConnector runtime.",
    "Give agents one policy-governed tool for thousands of provider actions.",
  ],
  wecom: [
    "Post agent results into a WeCom group.",
  ],
};

export const APP_CONNECTORS: AppConnectorManifest[] = APP_CONNECTOR_PROVIDER_MANIFESTS.map((connector) => ({
  ...connector,
  agentUseCases: AGENT_USE_CASES[connector.id],
}));
