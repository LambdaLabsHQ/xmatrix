import type { ConnectorAction, ConnectorDelivery, ConnectorDeliveryResult, ConnectorProvider } from "./provider";
import { DINGTALK_ACTIONS, GOOGLE_CHAT_ACTIONS, TEAMS_ACTIONS, TELEGRAM_ACTIONS, WECOM_ACTIONS, verifyTelegram } from "./actions/chat-webhooks";
import { BITBUCKET_ACTIONS, verifyBitbucket } from "./actions/bitbucket";
import { DISCORD_ACTIONS, verifyDiscord } from "./actions/discord";
import { FEISHU_ACTIONS } from "./actions/feishu";
import { GITLAB_ACTIONS, verifyGitLab } from "./actions/gitlab";
import { JIRA_ACTIONS, verifyJira } from "./actions/jira";
import { LINEAR_ACTIONS, verifyLinear } from "./actions/linear";
import { NOTION_ACTIONS, verifyNotion } from "./actions/notion";
import { GOOGLE_ACTIONS, verifyGoogle } from "./actions/google";
import { GOOGLE_SEARCH_CONSOLE_ACTIONS, verifyGoogleSearchConsole } from "./actions/google-search-console";
import { GOOGLE_ADSENSE_ACTIONS, verifyGoogleAdsense } from "./actions/google-adsense";
import { OPENCONNECTOR_ACTIONS, verifyOpenConnector } from "./actions/openconnector";
import { PAGERDUTY_ACTIONS, verifyPagerDuty } from "./actions/pagerduty";
import { SENTRY_ACTIONS, verifySentry } from "./actions/sentry";
import { SLACK_ACTIONS, verifySlack } from "./actions/slack";
import { VERCEL_ACTIONS } from "./actions/vercel";
import { CLOUDFLARE_ACTIONS, CLOUDFLARE_SUBSCRIPTIONS, verifyCloudflare } from "./cloudflare-api";
import { receiveCloudflareDelivery } from "./cloudflare-events";
import { GCP_ACTIONS, verifyGcp } from "./gcp-api";
import { receiveGcpDelivery } from "./gcp-events";
import { connectorCommands } from "./connector-commands";
import { verifyFeishu } from "./feishu-api";
import { receiveFeishuDelivery } from "./feishu-events";
import { receiveGitLabDelivery } from "./gitlab-events";
import { receiveJiraDelivery } from "./jira-events";
import { receiveLinearDelivery } from "./linear-events";
import { verifyNetlify } from "./netlify-api";
import { receivePagerDutyDelivery } from "./pagerduty-events";
import { receiveSentryDelivery } from "./sentry-events";
import { receiveSlackDelivery } from "./slack-events";
import { receiveVercelDelivery } from "./vercel-events";
import { verifyVercel } from "./vercel-api";
import {
  receiveBitbucketDelivery, receiveBuildkiteDelivery, receiveCircleCiDelivery, receiveGrafanaDelivery,
  receiveNetlifyDelivery, receiveOpsgenieDelivery, receiveStripeDelivery, receiveTelegramDelivery,
} from "./wave2-events";
import { receiveWebhookDelivery } from "./webhook-events";

/* Providers built on the generic platform (connector-platform.md §4): their
   event receiver, if they deliver events, and their outbound actions. */
const PROVIDERS: Record<string, {
  receive?: (delivery: ConnectorDelivery) => Promise<ConnectorDeliveryResult>;
  actions?: Record<string, ConnectorAction>;
  verify?: ConnectorProvider["verify"];
  subscriptions?: ConnectorProvider["subscriptions"];
}> = {
  webhook: { receive: receiveWebhookDelivery },
  sentry: { receive: receiveSentryDelivery, actions: SENTRY_ACTIONS, verify: verifySentry },
  linear: { receive: (delivery) => receiveLinearDelivery(delivery), actions: LINEAR_ACTIONS, verify: verifyLinear },
  pagerduty: { receive: receivePagerDutyDelivery, actions: PAGERDUTY_ACTIONS, verify: verifyPagerDuty },
  gitlab: { receive: receiveGitLabDelivery, actions: GITLAB_ACTIONS, verify: verifyGitLab },
  slack: { receive: (delivery) => receiveSlackDelivery(delivery), actions: SLACK_ACTIONS, verify: verifySlack },
  jira: { receive: receiveJiraDelivery, actions: JIRA_ACTIONS, verify: verifyJira },
  vercel: { receive: receiveVercelDelivery, actions: VERCEL_ACTIONS, verify: verifyVercel },
  cloudflare: { receive: receiveCloudflareDelivery, actions: CLOUDFLARE_ACTIONS, verify: verifyCloudflare,
    subscriptions: CLOUDFLARE_SUBSCRIPTIONS },
  gcp: { receive: receiveGcpDelivery, actions: GCP_ACTIONS, verify: verifyGcp },
  feishu: { receive: receiveFeishuDelivery, actions: FEISHU_ACTIONS, verify: verifyFeishu },
  discord: { actions: DISCORD_ACTIONS, verify: verifyDiscord },
  notion: { actions: NOTION_ACTIONS, verify: verifyNotion },
  google: { actions: GOOGLE_ACTIONS, verify: verifyGoogle },
  googlesearchconsole: { actions: GOOGLE_SEARCH_CONSOLE_ACTIONS, verify: verifyGoogleSearchConsole },
  googleadsense: { actions: GOOGLE_ADSENSE_ACTIONS, verify: verifyGoogleAdsense },
  bitbucket: { receive: receiveBitbucketDelivery, actions: BITBUCKET_ACTIONS, verify: verifyBitbucket },
  circleci: { receive: receiveCircleCiDelivery },
  buildkite: { receive: receiveBuildkiteDelivery },
  stripe: { receive: (delivery) => receiveStripeDelivery(delivery) },
  grafana: { receive: receiveGrafanaDelivery },
  opsgenie: { receive: receiveOpsgenieDelivery },
  netlify: { receive: receiveNetlifyDelivery, verify: verifyNetlify },
  telegram: { receive: receiveTelegramDelivery, actions: TELEGRAM_ACTIONS, verify: verifyTelegram },
  teams: { actions: TEAMS_ACTIONS },
  googlechat: { actions: GOOGLE_CHAT_ACTIONS },
  dingtalk: { actions: DINGTALK_ACTIONS },
  wecom: { actions: WECOM_ACTIONS },
  openconnector: { actions: OPENCONNECTOR_ACTIONS, verify: verifyOpenConnector },
};

export const PLATFORM_CONNECTOR_PROVIDERS: readonly ConnectorProvider[] = Object.entries(PROVIDERS)
  .map(([id, { receive, actions, verify, subscriptions }]) => ({
    id,
    commands: connectorCommands(id, actions, subscriptions),
    ...(receive ? { events: { receive } } : {}),
    ...(actions ? { actions } : {}),
    ...(verify ? { verify } : {}),
    ...(subscriptions ? { subscriptions } : {}),
  }));
