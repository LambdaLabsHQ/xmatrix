---
title: "GitHub, Sentry, Linear and Slack for AI agents · xMatrix Docs"
description: "Bring events from GitHub, Sentry, Linear, Slack and 30 more apps into conversations, and let people and agents act on them with one-line commands."
---

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
| Google Business Profile | `googlebusinessprofile` | | `list_accounts`, `list_locations`, `performance`, `reviews`, `reply_review` |
| Google AdSense | `googleadsense` | | `list_accounts`, `list_sites`, `report` |
| PageSpeed Insights | `pagespeed` | | `audit`, `field` |
| Bing Webmaster Tools | `bingwebmaster` | | `list_sites`, `traffic`, `queries`, `pages`, `crawl_stats`, `submit_urls`, `submit_sitemap`, `indexnow` |
| Yandex Webmaster | `yandexwebmaster` | | `list_hosts`, `summary`, `queries`, `recrawl` |
| Gmail | `gmail` | | `search`, `read` |
| Notion | `notion` | | `read_page`, `append`, `create_page` |
| Slack | `slack` | Messages, reactions | `post` |
| App Store Connect | `appstoreconnect` | Version state, build upload, TestFlight review and feedback | `list_apps`, `status`, `builds`, `read_version`, `reviews`, `read_app`, `create_version`, `set_metadata`, `set_build`, `submit`, `cancel_submission`, `release`, `reply_review`, `set_app_info`, `set_age_rating`, `set_price`, `set_availability`, `set_review_contact`, `upload_build`, `upload_screenshot`, `commit_upload`, `read_upload`, `delete_upload`, `build_uploads`, `screenshot_specs`, `screenshots`, `set_screenshots`, `declare_encryption`, `signing`, `register_bundle_id`, `enable_capability`, `create_certificate`, `read_certificate`, `create_profile`, `read_profile`, `testflight`, `feedback`, `crash_log`, `add_to_group`, `submit_beta_review`, `set_test_notes` |
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

## Shipping an app to the App Store

With App Store Connect connected, an agent can take a build from upload to the store and tell you how review went. Connect it under **Apps** with an App Store Connect API key (Users and Access → Integrations): the Key ID, the Issuer ID and the `.p8` file's contents. The key needs the App Manager role.

```text
@appstoreconnect:subscribe:com.example.app
@appstoreconnect:create_version:com.example.app 1.2.0
@appstoreconnect:set_metadata:com.example.app 1.2.0 {"locale":"en-US","whatsNew":"Faster sync and two crash fixes."}
@appstoreconnect:set_build:com.example.app 1.2.0 412
@appstoreconnect:submit:com.example.app 1.2.0
@appstoreconnect:release:com.example.app 1.2.0
```

- `subscribe` registers the app's webhook at Apple for you. The conversation then hears when a build finishes processing and each time the version changes state: waiting for review, in review, rejected, approved, live. Use it as an [Automation trigger](pages.md#when-it-runs) to have an agent pick up a rejection.
- `create_version` creates the next version with manual release; add `release=after_approval` to let Apple publish it as soon as it is approved. App Review contact and sign-in details carry over from the previous version without appearing in the conversation.
- `set_build` takes the build number you uploaded, once Apple has processed it. The agent that built the app can upload it without any Apple key on its machine: see [Uploading files](#uploading-files) below.
- `submit` sends the version to App Review. If Apple refuses because the listing is incomplete, the receipt says what is missing.
- `release` publishes an approved version that waits for developer release. It cannot be undone; a Space admin can turn it off in a conversation with `@appstoreconnect:policy:release deny`.

`@appstoreconnect:status:com.example.app` shows where every version stands, and `reviews` and `reply_review` cover customer reviews. A version on another platform is written `macos/1.2.0`, `tvos/1.2.0` or `visionos/1.2.0`.

A new app needs a few things once before its first submission. `@appstoreconnect:read_app:com.example.app` shows which are still missing, and an agent can fill in most of them:

```text
@appstoreconnect:set_app_info:com.example.app {"locale":"en-US","name":"Example","subtitle":"Ship faster","privacyPolicyUrl":"https://example.com/privacy","primaryCategory":"PRODUCTIVITY"}
@appstoreconnect:set_app_info:com.example.app {"contentRightsDeclaration":"DOES_NOT_USE_THIRD_PARTY_CONTENT"}
@appstoreconnect:set_age_rating:com.example.app {"gambling":false,"userGeneratedContent":true,"violenceRealistic":"NONE"}
@appstoreconnect:set_price:com.example.app free
@appstoreconnect:set_availability:com.example.app all
@appstoreconnect:set_review_contact:com.example.app 1.0.0 {"contactFirstName":"Ada","contactLastName":"Lovelace","contactEmail":"ada@example.com","contactPhone":"+1 555 0100"}
```

The age rating answers are your statements to Apple about the app, so nothing is filled in for you: give every answer the questionnaire asks, and `read_app` lists the ones still unanswered as `null`.

### Uploading files

A build or a screenshot goes to Apple in three steps, and the file itself never passes through xMatrix:

```text
@appstoreconnect:upload_build:com.example.app 1.2.0 412 Example.ipa 48211034
@appstoreconnect:commit_upload:<upload id> build
@appstoreconnect:build_uploads:com.example.app 412
```

1. `upload_build` reserves the upload. Give it the version and build number that are inside the file, the file's name and its exact size in bytes. The receipt lists one or more parts: a method, a URL, a byte range and headers.
2. The agent on the machine that has the file sends each part's bytes to its URL with those headers. The URLs are Apple's, expire, and work only for this file.
3. `commit_upload` tells Apple the file is complete. Apple then processes the build; a subscribed conversation hears when it finishes, and `build_uploads` shows any errors Apple found.

Screenshots work the same way, then get placed on the listing:

```text
@appstoreconnect:screenshot_specs:* iphone
@appstoreconnect:upload_screenshot:com.example.app home-6.9.png 1482113
@appstoreconnect:commit_upload:<image id> image
@appstoreconnect:set_screenshots:com.example.app 1.2.0 {"locale":"en-US","group":"<group>","images":["<image id>","<image id>"]}
```

`screenshot_specs` lists Apple's placement groups, one per device family, with the exact pixel sizes each accepts. `set_screenshots` makes that language and group show exactly the images you name, in that order; an image can be reused across languages. `screenshots` shows what a version has now.

If Apple asks about export compliance, answer it for the build with `@appstoreconnect:declare_encryption:com.example.app 1.2.0 412 exempt`.

### Signing on a machine without an Apple ID

An agent on a fresh Mac or CI runner can set up App Store signing through the connector. The private key is made on that machine and stays there; only the signing request travels:

```text
@appstoreconnect:signing:com.example.app
@appstoreconnect:register_bundle_id:com.example.app Example App
@appstoreconnect:create_certificate:distribution -----BEGIN CERTIFICATE REQUEST----- …
@appstoreconnect:read_certificate:<certificate id>
@appstoreconnect:create_profile:com.example.app <certificate id>
@appstoreconnect:read_profile:<profile id>
```

`signing` shows what already exists. A team has only a few distribution certificates, so create one only when no machine still holds the key of an existing one. `enable_capability` turns on things like `PUSH_NOTIFICATIONS` for the bundle ID; create the profile after that.

### TestFlight

```text
@appstoreconnect:testflight:com.example.app
@appstoreconnect:add_to_group:com.example.app 1.2.0 412 Early Access
@appstoreconnect:set_test_notes:com.example.app 1.2.0 412 en-US Try the new sync.
@appstoreconnect:submit_beta_review:com.example.app 1.2.0 412
@appstoreconnect:feedback:com.example.app
@appstoreconnect:crash_log:<feedback id>
```

Subscribe the conversation with `feedback` among its kinds and an agent can pick up what testers report: `feedback` lists their comments with device, OS and build, and `feedback:… crashes` with `crash_log` gives the crash behind a report.

### When App Review rejects a version

The conversation hears the rejection, but Apple offers no way to read the reviewer's message or reply to it outside App Store Connect, so a person reads it there. Once the problem is fixed, `submit` sends the same submission back to review; `cancel_submission` followed by `submit` starts a new one.

Apple keeps a few steps for a person in App Store Connect: creating the app record the first time, answering the App Privacy questions, entering the App Review sign-in password if reviewers need one, accepting agreements, and reading and replying to App Review's messages.

## Agents and apps

An agent in a conversation can use the Space's connected apps as tools, with the same actions and the same rules as a person typing the command. You do not configure anything on the agent.

## Limiting an action

By default every action of a connected app is available in every conversation of the Space, to people and to agents; the service's own permissions still apply. A Space admin can turn an action off in a conversation:

```text
@github:policy:merge deny
@github:policy:merge default
```

`deny` blocks the action in that conversation for everyone. `default` removes the rule.
