import type { AppConnectorProviderId, AppConnectorProviderKind } from "./authority.js";
import type { AppConnectorProviderManifest } from "./app-connector-manifests.js";

/*
 * Providers that deliver events through the per-connection ingress
 * (docs/design/connector-platform.md §3.3, §4). Each keeps its signing or
 * verification secret in the encrypted connector credential store; a
 * `generated` value is one the Hub mints for the admin to paste into the
 * provider, any other is copied from the provider into xMatrix.
 */

type Credential = NonNullable<AppConnectorProviderManifest["credentials"]>[number];
type Feature = { id: string; label: string; description: string };
type Action = AppConnectorProviderManifest["actions"][number];

function writeAction(id: string, label: string, description: string, usage: string): Action {
  return { id, label, description, usage, effect: "write", completion: { trailingDelimiter: ":" } };
}

function readAction(id: string, label: string, description: string, usage: string): Action {
  return { id, label, description, usage, effect: "read", completion: { trailingDelimiter: ":" } };
}

/* A write an Agent may run by default, unless a Space admin denies it in the Channel. */
function agentWriteAction(id: string, label: string, description: string, usage: string): Action {
  return { ...writeAction(id, label, description, usage), defaultPolicy: "allow" };
}

/* Every provider with write actions takes the per-Channel policy command. */
function withPolicy(actions: Action[]): Action[] {
  return actions.length === 0 ? [] : [...actions, {
    id: "policy",
    label: "Set action policy",
    description: "Space admins: allow Agents to run a write action in this channel, deny it for everyone, or reset it to the default.",
    usage: "<action> allow|deny|default",
    completion: { trailingDelimiter: ":" },
  }];
}

type ConnectorBase = {
  id: AppConnectorProviderId;
  name: string;
  kind: AppConnectorProviderKind;
  description: string;
  credentials: Credential[];
  oauth?: AppConnectorProviderManifest["oauth"];
};

/* The fields every platform-built manifest shares. */
function baseManifest(input: ConnectorBase): Omit<AppConnectorProviderManifest, "actions"> {
  return { id: input.id, name: input.name, kind: input.kind, status: "available", description: input.description,
    auth: { type: "api-token", scopes: [], secretRefs: [] }, ...(input.oauth ? { oauth: input.oauth } : {}),
    credentials: input.credentials };
}

function eventConnector(input: ConnectorBase & {
  source: { label: string; description: string; pattern: string; placeholder: string };
  features: Feature[];
  defaultFeatures?: string[];
  actions?: Action[];
}): AppConnectorProviderManifest {
  return {
    ...baseManifest(input),
    events: {
      source: input.source,
      features: input.features,
      defaultFeatures: input.defaultFeatures ?? input.features.map((feature) => feature.id),
    },
    actions: [
      {
        id: "subscribe",
        label: `Subscribe ${input.source.label.toLowerCase()}`,
        description: `Post ${input.name} events for a ${input.source.label.toLowerCase()} (or * for all) into the current channel.`,
        completion: { trailingDelimiter: ":" },
      },
      {
        id: "unsubscribe",
        label: `Unsubscribe ${input.source.label.toLowerCase()}`,
        description: `Stop posting ${input.name} events for a ${input.source.label.toLowerCase()} into the current channel.`,
        completion: { trailingDelimiter: ":" },
      },
      ...withPolicy(input.actions ?? []),
    ],
  };
}

function actionConnector(input: ConnectorBase & { actions: Action[] }): AppConnectorProviderManifest {
  return { ...baseManifest(input), actions: withPolicy(input.actions) };
}

const SLUG = "^[a-z0-9][a-z0-9_.-]{0,99}$";

/* The values one-click OAuth keeps for a provider whose token expires. */
const OAUTH_TOKEN_CREDENTIALS: Credential[] = [
  { id: "oauthToken", label: "OAuth access token", managed: true, description: "Set by Connect with OAuth; never typed by hand." },
  { id: "oauthRefreshToken", label: "OAuth refresh token", managed: true, description: "Set by Connect with OAuth." },
  { id: "oauthExpiresAt", label: "OAuth token expiry", managed: true, description: "Set by Connect with OAuth." },
];

export const EVENT_CONNECTOR_MANIFESTS: AppConnectorProviderManifest[] = [
  {
    ...actionConnector({
      id: "google", name: "Google Docs, Drive & Sheets", kind: "docs",
      description: "Read app-authorized Google Docs and Sheets, create files, and write work results. Access is limited to files created by or explicitly opened with xMatrix.",
      oauth: { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token",
        scopes: ["https://www.googleapis.com/auth/drive.file"], tokenField: "oauthToken",
        extraAuthorizeParams: { access_type: "offline", prompt: "consent" } },
      credentials: [...OAUTH_TOKEN_CREDENTIALS],
      actions: [
        { id: "read_sheet", label: "Read sheet range", description: "Read an explicit bounded A1 rectangle, including formula text.",
          usage: "<spreadsheet id> <A1 range>", effect: "read", completion: { trailingDelimiter: ":" } },
        writeAction("update_sheet", "Update sheet range", "Write an exact rectangle of RAW values; formula-like strings remain text.", '<spreadsheet id> {"range":"Sheet1!A1:B2","values":[["name","count"],["result",1]]}'),
        writeAction("create_sheet", "Create spreadsheet", "Create a blank app-authorized Google spreadsheet.", "new <title>"),
        { id: "read_doc", label: "Read document", effect: "read", usage: "<document id or Docs URL>",
          description: "Read a bounded plain-text excerpt across document tabs and tables. The file must already be authorized to xMatrix.",
          completion: { trailingDelimiter: ":" } },
        { id: "list_files", label: "List authorized files", effect: "read", usage: "*",
          description: "List up to 20 app-authorized Drive files; this does not search your entire Drive.",
          completion: { trailingDelimiter: ":" } },
        writeAction("create_doc", "Create document", "Create a blank Google Doc with the supplied title.", "new <title>"),
        writeAction("append_doc", "Append to document", "Append plain text to the selected tab, or the first tab when none is specified.",
          "<document id or Docs URL>[#tab=<tab id>] <text>"),
      ],
    }),
    auth: { type: "oauth", scopes: ["https://www.googleapis.com/auth/drive.file"], secretRefs: [] },
  },
  {
    ...actionConnector({
      id: "googlesearchconsole", name: "Google Search Console", kind: "observability",
      description: "Read search performance, sitemaps and URL index status for the Search Console properties the connected Google account can see, and submit sitemaps.",
      oauth: { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token",
        scopes: ["https://www.googleapis.com/auth/webmasters"], tokenField: "oauthToken",
        extraAuthorizeParams: { access_type: "offline", prompt: "consent" } },
      credentials: [...OAUTH_TOKEN_CREDENTIALS],
      actions: [
        readAction("list_sites", "List properties", "List the Search Console properties and permission levels of the connected account.", "*"),
        readAction("query", "Query search performance", "Clicks, impressions, CTR and average position, grouped by up to three dimensions. Defaults: by=query days=28 limit=25 type=web.",
          "<sc-domain:example.com or https://www.example.com/> [by=query,page|none] [days=1-480] [limit=1-250] [type=web|image|video|news|discover|googleNews]"),
        readAction("list_sitemaps", "List sitemaps", "List submitted sitemaps with their errors, warnings and indexed counts.", "<property>"),
        readAction("inspect_url", "Inspect URL", "Read Google's index status, last crawl and canonical for one page of the property.", "<property> <page url>"),
        writeAction("submit_sitemap", "Submit sitemap", "Submit or resubmit a sitemap URL that belongs to the property.", "<property> <sitemap url>"),
      ],
    }),
    auth: { type: "oauth", scopes: ["https://www.googleapis.com/auth/webmasters"], secretRefs: [] },
  },
  eventConnector({
    id: "webhook",
    name: "Webhook",
    kind: "webhook",
    description: "Receive JSON from any system that can POST a webhook, such as CI, deploys, monitors, or internal tools, and post each delivery into subscribed channels.",
    credentials: [{ id: "signingSecret", label: "Signing secret", generated: true,
      description: "Optional HMAC-SHA256 key. A delivery that carries X-Xmatrix-Signature: sha256=<hex> must match it." }],
    source: { label: "Source", placeholder: "deploys", pattern: "^[a-z0-9][a-z0-9_.-]{0,63}$",
      description: "The name a sender appends to the ingress URL as ?source=<name>; deliveries without one use default." },
    features: [{ id: "delivery", label: "Deliveries", description: "Every JSON delivery for the source." }],
  }),
  eventConnector({
    id: "sentry",
    name: "Sentry",
    kind: "observability",
    description: "Route new, regressed, and resolved Sentry issues and alerts into the channel where agents can fix them.",
    oauth: { authorizeUrl: "https://sentry.io/oauth/authorize/", tokenUrl: "https://sentry.io/oauth/token/",
      scopes: ["org:read", "project:read", "event:write"], tokenField: "oauthToken" },
    credentials: [{ id: "clientSecret", label: "Client secret",
      description: "For signed events: Settings → Developer Settings → your integration → Client Secret." },
      { id: "authToken", label: "Auth token", description: "For actions: an internal integration token with Issue & Event write." },
      { id: "organization", label: "Organization slug", description: "For actions: your Sentry organization slug." },
      { id: "baseUrl", label: "Sentry URL", description: "For actions on self-hosted or regional Sentry; defaults to https://sentry.io." },
      ...OAUTH_TOKEN_CREDENTIALS,
      ...["oauthClientId", "oauthAppUuid", "oauthAppSlug", "oauthInstallationId", "oauthOrganization", "oauthOrganizationId", "oauthScopes"]
        .map(id => ({ id, label: id, managed: true, description: "Confirmed by the Sentry Public Integration installation exchange." })),
    ],
    source: { label: "Project", placeholder: "web", pattern: SLUG,
      description: "A Sentry project slug. Metric alerts carry no project and reach channels subscribed to *." },
    features: [
      { id: "issue.created", label: "New issues", description: "A new issue was first seen." },
      { id: "issue.regressed", label: "Regressions", description: "A resolved issue came back." },
      { id: "issue.resolved", label: "Resolved", description: "An issue was resolved." },
      { id: "issue.assigned", label: "Assigned", description: "An issue was assigned." },
      { id: "issue.ignored", label: "Ignored", description: "An issue was ignored or archived." },
      { id: "alert", label: "Alerts", description: "Issue alert and metric alert notifications." },
      { id: "comment", label: "Comments", description: "Comments on issues." },
    ],
    defaultFeatures: ["issue.created", "issue.regressed", "alert"],
    actions: [
      readAction("read_issue", "Read issue context", "Read one Sentry issue and bounded latest-event exception frames.", "<issue short id or numeric id>"),
      agentWriteAction("resolve", "Resolve issue", "Mark a Sentry issue resolved.", "<issue short id>"),
      agentWriteAction("unresolve", "Unresolve issue", "Mark a Sentry issue unresolved.", "<issue short id>"),
      agentWriteAction("ignore", "Ignore issue", "Mark a Sentry issue ignored.", "<issue short id>"),
    ],
  }),
  eventConnector({
    id: "linear",
    name: "Linear",
    kind: "issue-tracker",
    description: "Route Linear issue, comment, and project updates into channels so agents pick up work where it is discussed.",
    oauth: { authorizeUrl: "https://linear.app/oauth/authorize", tokenUrl: "https://api.linear.app/oauth/token",
      scopes: ["read", "write"], scopeSeparator: ",", tokenField: "oauthToken" },
    credentials: [{ id: "signingSecret", label: "Signing secret",
      description: "For events: Settings → API → Webhooks → your webhook → Signing secret, with the ingress URL as the URL." },
      { id: "apiKey", label: "API key", description: "For actions: a Linear personal API key (Settings → Security & access)." },
      ...OAUTH_TOKEN_CREDENTIALS,
    ],
    source: { label: "Team", placeholder: "eng", pattern: "^[a-z0-9]{1,16}$",
      description: "A Linear team key, such as ENG. Project and cycle updates reach channels subscribed to *." },
    features: [
      { id: "issue", label: "Issues", description: "Issues created, updated, or removed." },
      { id: "comment", label: "Comments", description: "Comments on issues." },
      { id: "project", label: "Projects", description: "Project, project update, and cycle changes." },
    ],
    defaultFeatures: ["issue", "comment"],
    actions: [
      readAction("read_issue", "Read issue", "Read one issue's description, state and a bounded comment excerpt.", "<ENG-42>"),
      writeAction("comment", "Comment on issue", "Add a comment to a Linear issue.", "<ENG-42> <text>"),
      writeAction("create_issue", "Create issue", "Create a Linear issue in a team; the first line is the title.", "<team key> <title>\n<description>"),
    ],
  }),
  eventConnector({
    id: "pagerduty",
    name: "PagerDuty",
    kind: "incident",
    description: "Route PagerDuty incidents into an incident channel the moment they trigger, acknowledge, or resolve.",
    oauth: { authorizeUrl: "https://identity.pagerduty.com/oauth/authorize", tokenUrl: "https://identity.pagerduty.com/oauth/token",
      scopes: ["abilities.read", "incidents.read", "incidents.write"], tokenField: "oauthToken", pkce: "S256" },
    credentials: [{ id: "webhookSecret", label: "Webhook signing secret",
      description: "For inbound events: shown once when creating the Generic Webhook (v3) subscription in PagerDuty." },
      { id: "apiKey", label: "REST API key", description: "For actions: a PagerDuty REST API key." },
      { id: "fromEmail", label: "From email", description: "For manual API key writes: the acting PagerDuty user email." },
      { id: "apiRegion", label: "API region", description: "For manual API keys only: us (default) or eu. OAuth uses the signed grant region." },
      ...OAUTH_TOKEN_CREDENTIALS,
      ...["oauthScopes", "oauthClientId", "oauthRegion", "oauthAccountId", "oauthSubdomain"].map(id => ({
        id, label: "OAuth account context", description: "Verified and stored by the Hub during Scoped OAuth.", managed: true })),
    ],
    source: { label: "Service", placeholder: "p1abc23", pattern: "^[a-z0-9]{1,32}$",
      description: "A PagerDuty service id, such as P1ABC23." },
    features: [
      { id: "triggered", label: "Triggered", description: "An incident was triggered." },
      { id: "acknowledged", label: "Acknowledged", description: "An incident was acknowledged." },
      { id: "resolved", label: "Resolved", description: "An incident was resolved." },
      { id: "updated", label: "Other updates", description: "Reassignment, escalation, priority, and notes." },
    ],
    defaultFeatures: ["triggered", "acknowledged", "resolved"],
    actions: [
      readAction("read_incident", "Read incident", "Read one incident's title, status and a bounded note excerpt.", "<incident id>"),
      writeAction("acknowledge", "Acknowledge incident", "Acknowledge a PagerDuty incident.", "<incident id>"),
      writeAction("resolve", "Resolve incident", "Resolve a PagerDuty incident.", "<incident id>"),
      writeAction("note", "Add note", "Add a note to a PagerDuty incident.", "<incident id> <text>"),
    ],
  }),
  eventConnector({
    id: "gitlab",
    name: "GitLab",
    kind: "code-host",
    description: "Route GitLab merge requests, pushes, pipelines, issues, comments, and releases into channels.",
    oauth: { authorizeUrl: "https://gitlab.com/oauth/authorize", tokenUrl: "https://gitlab.com/oauth/token",
      scopes: ["api"], tokenField: "oauthToken" },
    credentials: [{ id: "webhookToken", label: "Secret token", generated: true,
      description: "Paste into GitLab: Settings → Webhooks → Secret token, with the ingress URL as the URL." },
      { id: "accessToken", label: "Access token", description: "For actions: a project, group, or personal access token with api scope." },
      { id: "baseUrl", label: "GitLab URL", description: "For self-managed GitLab; defaults to https://gitlab.com." },
      ...OAUTH_TOKEN_CREDENTIALS,
    ],
    source: { label: "Project", placeholder: "group/project", pattern: "^[a-z0-9][a-z0-9_.-]*(?:/[a-z0-9][a-z0-9_.-]*){1,9}$",
      description: "A project path with its namespace, such as group/project." },
    features: [
      { id: "merge_requests", label: "Merge requests", description: "Merge requests opened, updated, merged, or closed." },
      { id: "pushes", label: "Pushes", description: "Branch and tag pushes." },
      { id: "pipelines", label: "Pipelines", description: "Pipelines that succeed, fail, or are canceled." },
      { id: "issues", label: "Issues", description: "Issues opened, updated, or closed." },
      { id: "comments", label: "Comments", description: "Comments on merge requests, issues, and commits." },
      { id: "releases", label: "Releases", description: "Releases created or updated." },
    ],
    defaultFeatures: ["merge_requests", "pipelines", "issues"],
    actions: [
      readAction("read_issue", "Read issue", "Read one issue's description, state and a bounded note excerpt.", "<group/project#5>"),
      readAction("read_merge_request", "Read merge request", "Read one merge request's description, state and a bounded note excerpt.", "<group/project!5>"),
      writeAction("comment", "Comment", "Comment on a merge request (group/project!5) or issue (group/project#12).", "<group/project!5> <text>"),
      writeAction("merge", "Merge merge request", "Merge a GitLab merge request.", "<group/project!5>"),
      writeAction("retry_pipeline", "Retry pipeline", "Retry the failed jobs of a pipeline.", "<group/project/123>"),
    ],
  }),
  eventConnector({
    id: "slack",
    name: "Slack",
    kind: "chat",
    description: "Bring messages and reactions from linked Slack channels into xMatrix channels, so humans can stay in Slack.",
    oauth: { authorizeUrl: "https://slack.com/oauth/v2/authorize", tokenUrl: "https://slack.com/api/oauth.v2.access",
      scopes: ["chat:write", "channels:read", "channels:history", "groups:history", "reactions:read"], scopeSeparator: ",",
      tokenField: "botToken" },
    credentials: [{ id: "signingSecret", label: "Signing secret",
      description: "For events: your Slack app's Basic Information → App Credentials → Signing Secret, with Event Subscriptions → Request URL set to the ingress URL." },
      { id: "botToken", label: "Bot token", description: "For posting: the app's Bot User OAuth Token (xoxb-…) with chat:write." },
    ],
    source: { label: "Slack channel", placeholder: "c0123456789", pattern: "^[a-z0-9]{6,24}$",
      description: "A Slack channel id, such as C0123456789 (channel details → About)." },
    features: [
      { id: "messages", label: "Messages", description: "Messages people post in the Slack channel." },
      { id: "reactions", label: "Reactions", description: "Emoji reactions added in the Slack channel." },
    ],
    defaultFeatures: ["messages"],
    actions: [
      writeAction("post", "Post message", "Post a message to a Slack channel or thread.", "<channel id>[/<thread ts>] <text>"),
    ],
  }),
  eventConnector({
    id: "jira",
    name: "Jira",
    kind: "issue-tracker",
    description: "Route Jira Cloud issue and comment updates into channels.",
    oauth: { authorizeUrl: "https://auth.atlassian.com/authorize", tokenUrl: "https://auth.atlassian.com/oauth/token",
      scopes: ["read:jira-work", "write:jira-work", "offline_access"], tokenRequest: "json", tokenField: "oauthToken",
      extraAuthorizeParams: { audience: "api.atlassian.com", prompt: "consent" } },
    credentials: [{ id: "webhookSecret", label: "Webhook secret", generated: true,
      description: "Paste into Jira: Settings → System → WebHooks → your webhook → Secret, with the ingress URL as the URL." },
      { id: "siteUrl", label: "Site URL", description: "For actions: your Jira Cloud site, such as https://acme.atlassian.net." },
      { id: "email", label: "Account email", description: "For actions: the Atlassian account the API token belongs to." },
      { id: "apiToken", label: "API token", description: "For actions: an Atlassian API token (id.atlassian.com → Security)." },
      ...OAUTH_TOKEN_CREDENTIALS,
      { id: "cloudId", label: "Atlassian site id", managed: true, description: "Set by Connect with OAuth." },
    ],
    source: { label: "Project", placeholder: "eng", pattern: "^[a-z0-9_]{1,20}$",
      description: "A Jira project key, such as ENG." },
    features: [
      { id: "issues", label: "Issues", description: "Issues created, updated, or deleted." },
      { id: "comments", label: "Comments", description: "Comments created, updated, or deleted." },
    ],
    actions: [
      readAction("read_issue", "Read issue", "Read a Jira Cloud issue and a bounded plain-text excerpt of its newest comments.", "<ENG-9>"),
      writeAction("comment", "Comment on issue", "Add a comment to a Jira issue.", "<ENG-9> <text>"),
      writeAction("transition", "Transition issue", "Move a Jira issue to a status.", "<ENG-9> <status>"),
    ],
  }),
  eventConnector({
    id: "vercel",
    name: "Vercel",
    kind: "deploy",
    description: "Route Vercel deployments into channels so agents see failed deploys as soon as they happen.",
    oauth: { authorizeUrl: "https://vercel.com/integrations/xmatrix/new", tokenUrl: "https://api.vercel.com/v2/oauth/access_token",
      scopes: [], tokenField: "oauthToken", flow: "vercel-integration" },
    credentials: [{ id: "webhookSecret", label: "Webhook secret",
      description: "Shown when you create the webhook in Vercel: Team Settings → Webhooks." },
      { id: "accessToken", label: "Access token", description: "For actions: a Vercel access token." },
      { id: "teamId", label: "Team id", description: "For actions on a team's projects: the team id (team_…)." },
      ...OAUTH_TOKEN_CREDENTIALS,
      { id: "oauthConfigurationId", label: "Integration installation", description: "The verified Vercel configuration.", managed: true },
      { id: "oauthTeamId", label: "Integration team", description: "The team returned by Vercel during authorization.", managed: true },
      { id: "oauthUserId", label: "Integration account", description: "The personal account returned by Vercel for a personal installation.", managed: true },
      { id: "oauthAppClientId", label: "Integration application", description: "The registered application that issued the grant.", managed: true },
    ],
    source: { label: "Project", placeholder: "web", pattern: SLUG, description: "A Vercel project name." },
    features: [
      { id: "created", label: "Started", description: "A deployment started." },
      { id: "succeeded", label: "Succeeded", description: "A deployment is ready." },
      { id: "failed", label: "Failed", description: "A deployment errored or was canceled." },
    ],
    defaultFeatures: ["failed", "succeeded"],
    actions: [
      writeAction("redeploy", "Redeploy", "Redeploy an existing Vercel deployment.", "<deployment id>"),
    ],
  }),
  eventConnector({
    id: "cloudflare",
    name: "Cloudflare",
    kind: "deploy",
    description: "Connect a Cloudflare account: subscribing to an alert type sets up its notification, alerts reach channels and Automations as they fire and resolve, and Agents read Workers logs and deployments and can roll a Worker back.",
    oauth: { authorizeUrl: "https://dash.cloudflare.com/oauth2/auth", tokenUrl: "https://dash.cloudflare.com/oauth2/token",
      scopes: ["offline_access", "account-settings.read", "notifications.read", "notifications.write",
        "workers-observability.write", "workers-scripts.edit"],
      tokenField: "oauthToken" },
    credentials: [
      ...OAUTH_TOKEN_CREDENTIALS,
      { id: "apiToken", label: "API token",
        description: "Instead of OAuth: an account API token with Notifications Edit, Workers Observability Write and Workers Scripts Edit." },
      { id: "accountId", label: "Account ID",
        description: "Only when your Cloudflare login reaches more than one account: the account to connect." },
      { id: "webhookSecret", label: "Webhook secret", generated: true,
        description: "xMatrix registers it on the webhook destination it creates; nothing to paste." },
    ],
    source: { label: "Alert type", placeholder: "workers_observability_real_time_issue", pattern: "^[a-z0-9_]{1,80}$",
      description: "A Cloudflare notification alert type; subscribing creates its notification policy. * routes every notification the account already sends to xMatrix." },
    features: [
      { id: "fired", label: "Fired", description: "The alert fired." },
      { id: "resolved", label: "Resolved", description: "The alert resolved." },
    ],
    actions: [
      readAction("query_logs", "Query Workers logs", "Count a Worker's log events by message over a recent window.", "<worker> [minutes] [error|warn|log]"),
      readAction("list_deployments", "List deployments", "List a Worker's five most recent deployments and their versions.", "<worker>"),
      writeAction("rollback", "Roll back Worker", "Deploy a Worker's previous deployment, or a named version, at 100%.", "<worker> [version id] [reason]"),
    ],
  }),
  eventConnector({
    id: "feishu",
    name: "Feishu",
    kind: "chat",
    description: "Link the xMatrix company app to your Feishu groups, or configure your own Feishu / Lark app. Bring group messages into channels and send to confirmed groups.",
    credentials: [
      { id: "verificationToken", label: "Verification Token", required: true,
        description: "From the Feishu developer console: your app → Events & Callbacks → Encryption Strategy." },
      { id: "encryptKey", label: "Encrypt Key",
        description: "Only if you set an Encrypt Key in the same place." },
    
      { id: "appId", label: "App ID", description: "For sending: the Feishu app's App ID (cli_…)." },
      { id: "appSecret", label: "App Secret", description: "For sending: the Feishu app's App Secret." },
      { id: "apiBase", label: "API base", description: "For Lark: https://open.larksuite.com; defaults to https://open.feishu.cn." },
    ],
    source: { label: "Chat", placeholder: "room-… or oc_0123456789abcdef", pattern: "^(?:room-[a-f0-9]{64}|[a-z0-9_]{4,64})$",
      description: "For the company app, copy the Channel subscription shown after linking a group. For your own app, use its chat ID (oc_…)." },
    features: [{ id: "messages", label: "Messages", description: "Messages people send in the chat." }],
    actions: [
      writeAction("send", "Send message", "Send a text message to a Feishu chat the app is in.", "<chat id> <text>"),
    ],
  }),
  actionConnector({
    id: "discord",
    name: "Discord",
    kind: "chat",
    description: "Install the xMatrix bot in a Discord server and post updates to its text channels, or use your own bot.",
    oauth: { authorizeUrl: "https://discord.com/oauth2/authorize", tokenUrl: "https://discord.com/api/v10/oauth2/token",
      scopes: ["bot", "identify"], clientAuth: "basic", tokenField: "oauthToken",
      extraAuthorizeParams: { permissions: "3072", integration_type: "0", prompt: "consent" } },
    credentials: [{ id: "botToken", label: "Bot token", required: true,
      description: "From the Discord Developer Portal: your application → Bot → Token. The bot needs Send Messages in the channel. Saving this field explicitly replaces the company bot installation." },
      ...OAUTH_TOKEN_CREDENTIALS,
      ...["oauthClientId", "oauthGuildId", "oauthUserId", "oauthScopes"].map(id => ({ id, label: id, managed: true,
        description: "Provider-confirmed installation; never typed by hand." }))],
    actions: [writeAction("post", "Post message", "Post a message to a Discord channel.", "<channel id> <text>")],
  }),
  actionConnector({
    id: "notion",
    name: "Notion",
    kind: "docs",
    description: "Read authorized Notion pages, append findings or create new pages with the integration's access.",
    oauth: { authorizeUrl: "https://api.notion.com/v1/oauth/authorize", tokenUrl: "https://api.notion.com/v1/oauth/token",
      scopes: [], tokenRequest: "json", clientAuth: "basic", tokenField: "integrationToken",
      extraAuthorizeParams: { owner: "user" } },
    credentials: [{ id: "integrationToken", label: "Integration token", required: true,
      description: "From notion.so/my-integrations: an internal integration secret. Share the target pages with the integration." },
      ...OAUTH_TOKEN_CREDENTIALS.filter((field) => field.id !== "oauthToken")],
    actions: [
      { id: "read_page", label: "Read page", description: "Read a bounded plain-text excerpt of an authorized page, including nested blocks.",
        usage: "<page id or official URL>", effect: "read", completion: { trailingDelimiter: ":" } },
      writeAction("append", "Append to page", "Append paragraphs to a Notion page.", "<page id> <text>"),
      writeAction("create_page", "Create page", "Create a child page; the first line is the title.", "<parent page id> <title>\n<body>"),
    ],
  }),
  eventConnector({
    id: "bitbucket",
    name: "Bitbucket",
    kind: "code-host",
    description: "Read Bitbucket Cloud pull request context, write review comments, and receive signed repository events.",
    oauth: { authorizeUrl: "https://bitbucket.org/site/oauth2/authorize", tokenUrl: "https://bitbucket.org/site/oauth2/access_token",
      scopes: ["account", "pullrequest"], clientAuth: "basic", tokenField: "oauthToken" },
    credentials: [{ id: "webhookSecret", label: "Webhook secret", generated: true,
      description: "Paste into Bitbucket: Repository settings → Webhooks → Secret, with the ingress URL as the URL." },
      ...OAUTH_TOKEN_CREDENTIALS],
    source: { label: "Repository", placeholder: "workspace/repo", pattern: "^[a-z0-9][a-z0-9_.-]*/[a-z0-9][a-z0-9_.-]*$",
      description: "A repository full name, such as workspace/repo." },
    features: [
      { id: "pull_requests", label: "Pull requests", description: "Pull requests created, updated, approved, merged, or declined." },
      { id: "comments", label: "Comments", description: "Pull request comments." },
      { id: "pushes", label: "Pushes", description: "Branch pushes." },
      { id: "builds", label: "Builds", description: "Finished commit statuses." },
    ],
    defaultFeatures: ["pull_requests", "builds"],
    actions: [readAction("read_pull_request", "Read pull request", "Read one explicit PR and at most 20 comments; no linked files or profiles.", "<workspace/repo!id>"),
      writeAction("comment", "Comment on pull request", "Write a review comment on one explicit pull request.", "<workspace/repo!id> <text>")],
  }),
  eventConnector({
    id: "circleci",
    name: "CircleCI",
    kind: "ci",
    description: "Route finished CircleCI workflows and jobs into channels, so a failure reaches an agent at once.",
    credentials: [{ id: "webhookSecret", label: "Signing secret", generated: true,
      description: "Paste into CircleCI: Project Settings → Webhooks → Secret token, with the ingress URL as the Receiver URL." }],
    source: { label: "Project", placeholder: "gh/org/repo", pattern: "^[a-z0-9]+/[a-z0-9_.-]+/[a-z0-9_.-]+$",
      description: "A project slug, such as gh/org/repo." },
    features: [
      { id: "failed", label: "Failed", description: "Workflows or jobs that failed, errored, or were canceled." },
      { id: "succeeded", label: "Succeeded", description: "Workflows or jobs that succeeded." },
    ],
    defaultFeatures: ["failed"],
  }),
  eventConnector({
    id: "buildkite",
    name: "Buildkite",
    kind: "ci",
    description: "Route finished Buildkite builds into channels.",
    credentials: [{ id: "webhookToken", label: "Token", generated: true,
      description: "Paste into Buildkite: Settings → Notification Services → Webhook → Token, with the ingress URL as the Webhook URL." }],
    source: { label: "Pipeline", placeholder: "web", pattern: "^[a-z0-9][a-z0-9_.-]{0,99}$", description: "A pipeline slug." },
    features: [
      { id: "failed", label: "Failed", description: "Builds that failed or were canceled." },
      { id: "succeeded", label: "Passed", description: "Builds that passed." },
    ],
    defaultFeatures: ["failed"],
  }),
  eventConnector({
    id: "stripe",
    name: "Stripe",
    kind: "billing",
    description: "Route Stripe events, such as failed payments, disputes, and subscription changes, into channels.",
    credentials: [{ id: "signingSecret", label: "Signing secret", required: true,
      description: "From Stripe: Developers → Webhooks → your endpoint → Signing secret (whsec_…)." }],
    source: { label: "Object", placeholder: "invoice", pattern: "^[a-z_]{1,40}$",
      description: "The event type's object, such as invoice for invoice.payment_failed." },
    features: [{ id: "events", label: "Events", description: "Every event for the object." }],
  }),
  eventConnector({
    id: "grafana",
    name: "Grafana",
    kind: "observability",
    description: "Route Grafana alerts into channels as they fire and resolve.",
    credentials: [{ id: "webhookToken", label: "Bearer token", generated: true,
      description: "Paste into Grafana: Alerting → Contact points → Webhook → Authorization header credentials (scheme Bearer)." }],
    source: { label: "Contact point", placeholder: "xmatrix", pattern: "^[a-z0-9][a-z0-9_.-]{0,99}$",
      description: "The contact point (receiver) name." },
    features: [
      { id: "firing", label: "Firing", description: "Alerts that started firing." },
      { id: "resolved", label: "Resolved", description: "Alerts that resolved." },
    ],
  }),
  eventConnector({
    id: "opsgenie",
    name: "Opsgenie",
    kind: "incident",
    description: "Route Opsgenie alerts into an incident channel.",
    credentials: [{ id: "webhookToken", label: "Header token", generated: true,
      description: "In Opsgenie's Webhook integration, add the custom header X-Xmatrix-Token with this value." }],
    source: { label: "Integration", placeholder: "xmatrix", pattern: "^[a-z0-9][a-z0-9_.-]{0,99}$",
      description: "The Opsgenie integration name." },
    features: [
      { id: "created", label: "Created", description: "Alerts created." },
      { id: "acknowledged", label: "Acknowledged", description: "Alerts acknowledged." },
      { id: "closed", label: "Closed", description: "Alerts closed." },
      { id: "updated", label: "Other updates", description: "Notes, assignments, and escalations." },
    ],
    defaultFeatures: ["created", "acknowledged", "closed"],
  }),
  eventConnector({
    id: "netlify",
    name: "Netlify",
    kind: "deploy",
    description: "Connect your Netlify account and route deploys into channels.",
    oauth: { authorizeUrl: "https://app.netlify.com/authorize", tokenUrl: "https://api.netlify.com/oauth/token",
      scopes: [], tokenField: "oauthToken" },
    credentials: [{ id: "webhookSecret", label: "JWS secret", generated: true,
      description: "Paste into Netlify: Site configuration → Notifications → Outgoing webhook → JWS secret token." },
      ...OAUTH_TOKEN_CREDENTIALS,
    ],
    source: { label: "Site", placeholder: "web", pattern: "^[a-z0-9][a-z0-9_.-]{0,99}$", description: "A Netlify site name." },
    features: [
      { id: "created", label: "Started", description: "Deploys that started building." },
      { id: "succeeded", label: "Succeeded", description: "Deploys that are live." },
      { id: "failed", label: "Failed", description: "Deploys that failed." },
    ],
    defaultFeatures: ["failed", "succeeded"],
  }),
  eventConnector({
    id: "telegram",
    name: "Telegram",
    kind: "chat",
    description: "Bring messages from Telegram groups your bot is in into channels, and send replies back.",
    credentials: [
      { id: "webhookSecret", label: "Secret token", generated: true,
        description: "Pass as secret_token when you call setWebhook with the ingress URL." },
      { id: "botToken", label: "Bot token", required: true, description: "From @BotFather." },
    ],
    source: { label: "Chat", placeholder: "-1001234567890", pattern: "^-?[0-9]{1,20}$", description: "A Telegram chat id." },
    features: [{ id: "messages", label: "Messages", description: "Text messages people send in the chat." }],
    actions: [writeAction("send", "Send message", "Send a message to a Telegram chat the bot is in.", "<chat id> <text>")],
  }),
  eventConnector({
    id: "teams",
    name: "Microsoft Teams",
    kind: "chat",
    description: "Link a company Teams personal or group chat to receive messages and post replies. Manual Workflows webhooks remain outbound-only; legacy Office 365 Connectors are retired.",
    source: { label: "Conversation", placeholder: "*", pattern: "^room-[a-f0-9]{64}$",
      description: "Copy the confirmed conversation source from Apps → Microsoft Teams, or use *." },
    features: [{ id: "messages", label: "Messages", description: "Human messages delivered to the bot in the confirmed conversation." }],
    credentials: [{ id: "webhookUrl", label: "Webhook URL", required: true,
      description: "A Teams Workflows URL from Post to a channel when a webhook request is received. Legacy Office 365 Connectors stopped working in May 2026." }],
    actions: [writeAction("post", "Post message", "Post a message to the connected Teams conversation or explicit manual webhook.", "<text>")],
  }),
  eventConnector({
    id: "googlechat",
    name: "Google Chat",
    kind: "chat",
    description: "Receive messages mentioning the xMatrix app from a linked Google Chat space and post replies. A manual webhook remains available for outbound-only connections.",
    credentials: [{ id: "webhookUrl", label: "Webhook URL", required: true,
      description: "From the Google Chat space: Apps & integrations → Webhooks." }],
    source: { label: "Chat space", placeholder: "*", pattern: "^room-[a-f0-9]{64}$",
      description: "Use * for your linked space, or copy its source from Apps → Google Chat." },
    features: [{ id: "messages", label: "Messages", description: "Human messages mentioning the xMatrix app in the confirmed Chat space." }],
    actions: [writeAction("post", "Post message", "Post a message to the Google Chat space.", "<text>")],
  }),
  actionConnector({
    id: "dingtalk",
    name: "DingTalk",
    kind: "chat",
    description: "Confirm a company and explicit members to read contacts and request approved work notifications. Group robot webhooks remain a separate outbound option.",
    credentials: [
      { id: "accessToken", label: "Access token", required: true, description: "The access_token from the robot's webhook URL." },
      { id: "signSecret", label: "Signing secret", description: "If the robot uses the signature (加签) security setting." },
    ],
    actions: [writeAction("post", "Post to group robot", "Post through the manually configured DingTalk robot.", "<text>"),
      readAction("read", "Read company member", "Read the name and active status of one confirmed member.", "<member-recipient>"),
      writeAction("send", "Send work notification", "Request an approved template notification for one confirmed member; acceptance does not confirm delivery.", "<member-recipient> <text>")],
  }),
  eventConnector({
    id: "wecom",
    name: "WeCom",
    kind: "chat",
    description: "Connect a WeCom company application for member text message notifications and replies to explicitly confirmed members. Native message contents stay in WeCom. A group robot remains an outbound-only option.",
    credentials: [{ id: "webhookKey", label: "Webhook key", required: true, description: "The key from the group robot's webhook URL." }],
    source: { label: "Company member", placeholder: "*", pattern: "^member-[a-f0-9]{64}$",
      description: "Use * for confirmed members, or copy a member source from Apps → WeCom." },
    features: [{ id: "messages", label: "Message notifications", description: "Text message notifications from confirmed members; native contents stay in WeCom." }],
    actions: [writeAction("post", "Post to group robot", "Post through the manually configured WeCom group robot.", "<text>"),
      writeAction("send", "Send to company member", "Send a text message to one confirmed company member.", "<member-recipient> <text>")],
  }),
  actionConnector({
    id: "openconnector",
    name: "OpenConnector",
    kind: "gateway",
    description: "Discover and run actions available on your own OpenConnector runtime, under this channel's action policy and the runtime token's grants. Provider credentials stay in OpenConnector; xMatrix keeps only its runtime token. Catalog presence does not prove a provider is configured or usable.",
    credentials: [
      { id: "runtimeUrl", label: "Runtime URL", required: true,
        description: "Your OpenConnector runtime's public https URL, self-hosted or OOMOL-hosted." },
      { id: "runtimeToken", label: "Runtime token", required: true,
        description: "A persistent OpenConnector runtime token (sent as Authorization: Bearer)." },
    ],
    actions: [
      { id: "search", label: "Find actions", description: "List the actions your runtime offers for a service.",
        usage: "<service>", effect: "read", completion: { trailingDelimiter: ":" } },
      writeAction("run", "Run action", "Run one OpenConnector action with JSON input; @alias picks a named connection.",
        "<service.action>[@alias] <json input>"),
    ],
  }),
];
