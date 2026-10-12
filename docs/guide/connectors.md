# Connected apps

A connected app brings another service into a Space in two directions: its events arrive in conversations as messages, and people and agents act on it from a message.

A Space admin connects an app in the app's **Apps** view. Some connect through the service's own sign-in; others take a webhook URL or an API token. Credentials are stored for the Space and are never shown again.

## The command form

```text
@<app>:<action>:<target> <text>
```

- `<app>` is the app's id, such as `github` or `sentry`.
- `<action>` is one of the app's actions, in lower case with underscores.
- `<target>` is what the action applies to: a repository, an issue, a project. An action that needs no target takes `*`.
- `<text>` is whatever the action needs after that: a comment body, a title, options, or a JSON object.

The command must begin the message, and one message carries one command. Lines after the first belong to its text. Type `@` and the app's name and the composer walks you through the actions and their targets.

Every command leaves a receipt in the conversation with its result.

## Events

Subscribing a conversation to a source posts that source's events there:

```text
@github:subscribe:acme/web
@github:subscribe:acme/web pulls checks
@github:subscribe:acme/web:#42
@sentry:subscribe:web issue.created issue.regressed
@linear:subscribe:*
@github:unsubscribe:acme/web checks
```

The words after the target select which kinds of event to post. Without them the app's defaults apply, and `all` means every kind.

GitHub's kinds are `issues`, `pulls`, `comments`, `reviews`, `commits`, `checks`, `status` and `releases`. A pull request an agent opens is subscribed to the agent's conversation automatically, so its CI result, reviews and merge arrive where the work was asked for.

An event can also start an agent: see [Automation triggers](pages.md#when-it-runs).

## GitHub

GitHub is also what makes `repo:` work: connecting it gives the Space its repositories as launch targets and lets agents push with the Space's connection.

| Command | Effect |
| --- | --- |
| `@github:subscribe:OWNER/REPO [kinds]` | Post repository events here |
| `@github:subscribe:OWNER/REPO:#42` | Follow one issue or pull request |
| `@github:unsubscribe:OWNER/REPO [kinds]` | Stop |
| `@github:comment:OWNER/REPO:#42 <body>` | Comment on an issue or pull request |
| `@github:create_issue:OWNER/REPO <title>` | Create an issue; further lines are its body |
| `@github:close_issue:OWNER/REPO:#42` | Close an issue or pull request |
| `@github:reopen_issue:OWNER/REPO:#42` | Reopen it |
| `@github:review:OWNER/REPO:#42 approve <body>` | Review: `approve`, `request_changes` or `comment` |
| `@github:merge:OWNER/REPO:#42 squash` | Merge: `merge`, `squash` or `rebase` |
| `@github:rerun_failed_jobs:OWNER/REPO:RUN_ID` | Rerun the failed jobs of a workflow run |
| `@github:dispatch_workflow:OWNER/REPO:WORKFLOW.yml:REF {…}` | Run a workflow at a ref, with optional JSON inputs |

## Other apps

Each app's actions are listed in its panel under **Apps** and in the composer. The ones available today:

| App | Id | Events | Actions |
| --- | --- | --- | --- |
| GitLab | `gitlab` | Merge requests, pushes, pipelines, issues, comments, releases | `read_issue`, `read_merge_request`, `comment`, `merge`, `retry_pipeline` |
| Bitbucket | `bitbucket` | Pull requests, comments, pushes, builds | `read_pull_request`, `comment` |
| Sentry | `sentry` | New issues, regressions, resolved, assigned, ignored, alerts, comments | `read_issue`, `resolve`, `unresolve`, `ignore` |
| Linear | `linear` | Issues, comments, projects | `read_issue`, `comment`, `create_issue` |
| Jira | `jira` | Issues, comments | `read_issue`, `comment`, `transition` |
| PagerDuty | `pagerduty` | Triggered, acknowledged, resolved, updates | `read_incident`, `acknowledge`, `resolve`, `note` |
| Opsgenie | `opsgenie` | Created, acknowledged, closed, updates | |
| Grafana | `grafana` | Firing, resolved | |
| Vercel | `vercel` | Deployment started, succeeded, failed | `redeploy` |
| Netlify | `netlify` | Deploy started, succeeded, failed | |
| Cloudflare | `cloudflare` | Alert fired, resolved | `query_logs`, `list_deployments`, `rollback` |
| Google Cloud | `gcp` | Monitoring incident fired, resolved | Projects, Cloud Run, logs, metrics, costs, APIs |
| CircleCI | `circleci` | Failed, succeeded | |
| Buildkite | `buildkite` | Failed, passed | |
| Stripe | `stripe` | Every event of an object | |
| Google Docs, Drive & Sheets | `google` | | `read_doc`, `create_doc`, `append_doc`, `read_sheet`, `update_sheet`, `create_sheet`, `list_files` |
| Google Search Console | `googlesearchconsole` | | `query`, `inspect_url`, sitemaps, properties, verification |
| Google Analytics | `googleanalytics` | | `list_properties`, `report` |
| Google AdSense | `googleadsense` | | `list_accounts`, `list_sites`, `report` |
| PageSpeed Insights | `pagespeed` | | `audit`, `field` |
| Bing Webmaster Tools | `bingwebmaster` | | `list_sites`, `traffic`, `queries`, `pages`, `crawl_stats`, `submit_urls`, `submit_sitemap`, `indexnow` |
| Yandex Webmaster | `yandexwebmaster` | | `list_hosts`, `summary`, `queries`, `recrawl` |
| Gmail | `gmail` | | `search`, `read` |
| Notion | `notion` | | `read_page`, `append`, `create_page` |
| Slack | `slack` | Messages, reactions | `post` |
| Discord | `discord` | | `post` |
| Telegram | `telegram` | Messages | `send` |
| Feishu / Lark | `feishu` | Messages | `send` |
| Microsoft Teams | `teams` | Messages | `post` |
| Google Chat | `googlechat` | Messages | `post` |
| DingTalk | `dingtalk` | | `post`, `read`, `send` |
| WeCom | `wecom` | Messages | `post`, `send` |
| Webhook | `webhook` | Any signed JSON delivery | |
| OpenConnector | `openconnector` | | `search`, `run`: actions of your own OpenConnector runtime |

A few examples:

```text
@sentry:read_issue:WEB-1A2
@linear:create_issue:ENG Login fails on Safari
@gitlab:comment:group/project!5 Looks good.
@cloudflare:query_logs:api-worker 30 error
@google:create_doc:new Launch notes
@slack:post:C0123456789 Deploy finished.
```

## Agents and apps

An agent in a conversation can use the Space's connected apps as tools, with the same actions and the same rules as a person typing the command. You do not configure anything on the agent.

## Limiting an action

By default every action of a connected app is available in every conversation of the Space, to people and to agents; the service's own permissions still apply. A Space admin can turn an action off in a conversation:

```text
@github:policy:merge deny
@github:policy:merge default
```

`deny` blocks the action in that conversation for everyone. `default` removes the rule.
