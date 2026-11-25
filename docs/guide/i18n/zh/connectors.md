---
title: "面向 AI Agent 的 GitHub、Sentry、Linear 与 Slack 集成 · xMatrix 文档"
description: "将 GitHub、Sentry、Linear、Slack 等 30+ 外部应用的事件引入对话，让成员与 Agent 用一行指令安全操作。"
---

# 已连接应用

已连接应用（Connected apps）以双向方式把外部服务接入 Space：外部事件会作为消息实时进入对话，而团队成员与 Agent 则能直接通过消息指令操作外部服务。

Space 管理员可在应用的 **应用（Apps）** 视图中完成连接。部分服务通过官方 OAuth 登录授权，另一些则通过 Webhook URL 或 API 令牌接入。凭证按 Space 加密保存，保存后不再回显。

## 指令格式

```text
@<app>:<action>:<target> <text>
```

- `<app>` 是应用 ID，如 `github` 或 `sentry`。
- `<action>` 是该应用支持的动作名，使用小写字母加下划线。
- `<target>` 是动作作用的对象，如仓库、Issue 或项目。无需目标的动作填写 `*`。
- `<text>` 是动作所需的补充内容，如评论正文、标题、选项或 JSON 对象。

指令必须位于消息开头，且每条消息只执行一条指令；第一行之后的所有内容都属于 `<text>` 正文。在输入框键入 `@` 和应用名，系统会自动引导你补全动作与目标。

每条指令都会在对话中留下带执行结果的回执。

## 切换账号、暂停与移除

在已连接应用的详情页中，可以管理该连接的账号状态：

- **切换账号（Switch account）** 将连接切换到另一个账号。OAuth 登录类应用会唤起服务商的账号选择页（Google 始终询问选择哪个账号）；在新账号完成授权前，原账号保持在线。粘贴凭证类应用会跳转到凭证区，新凭证通过服务商校验后即替换旧凭证。Space 管理员也可以在字段上选择 **使用已保存密钥（Use a saved secret）**：Hub 会将该 Space 密钥的当前值复制到连接中并校验，全程不展示明文，且每次复制都会记入密钥审计日志。
- **暂停（Pause）** 会暂停指令执行和频道事件推送，但保留登录凭证。点击 **恢复（Resume）** 可沿用原账号立即启用，无需重新登录。
- **移除（Remove）** 在二次确认后会删除该连接、已保存的凭证以及所有频道订阅。

Google 类应用不支持暂停：xMatrix 会在停止时直接清除 Google 登录授权，因此提供的是 **退出登录（Sign out）**。支持多账号列表的应用（GitHub、Gmail、Stripe、Cloudflare、X）则可直接在账号列表中逐一添加或移除。

## 订阅事件

为对话订阅某个来源后，该来源的事件会自动推送到当前对话：

```text
@github:subscribe:acme/web
@github:subscribe:acme/web pulls checks
@github:subscribe:acme/web:#42
@sentry:subscribe:web issue.created issue.regressed
@linear:subscribe:*
@github:unsubscribe:acme/web checks
```

目标后面的词用于筛选事件类型；不写则使用应用默认类型，`all` 表示全部类型。

GitHub 支持的事件类型包括 `issues`、`pulls`、`comments`、`reviews`、`commits`、`checks`、`status` 和 `releases`。使用 `except:LOGIN` 可过滤掉指定 GitHub 账号触发的活动（包括它创建的 Issue/PR 及其他由它引发的事件）。例如 `@github:subscribe:acme/web issues pulls except:octocat` 会推送除此之外所有人的 Issue 和 PR；`@github:unsubscribe:acme/web except:octocat` 则取消该排除项。Agent 创建的 Pull Request 会自动订阅到发起它的对话中，因此其 CI 检查、评审意见与合入状态都会直接回到原地。

外部事件还可以直接唤醒 Agent：在页面上编写[监听事件的程序](programs.md#来自已连接应用的事件)即可。

## GitHub

连接 GitHub 同时也是 `repo:` 启动条件生效的前提：接入后，Space 内的仓库会自动成为 Agent 的启动目标，Agent 推送代码时也直接使用 Space 的 GitHub 连接。

| 指令 | 效果 |
| --- | --- |
| `@github:subscribe:OWNER/REPO [kinds]` | 将该仓库事件推送到当前对话 |
| `@github:subscribe:OWNER/REPO:#42` | 仅追踪单个 Issue 或 Pull Request |
| `@github:unsubscribe:OWNER/REPO [kinds]` | 取消订阅 |
| `@github:comment:OWNER/REPO:#42 <body>` | 在 Issue 或 Pull Request 下发表评论 |
| `@github:create_issue:OWNER/REPO <title>` | 创建 Issue；后续行作为正文 |
| `@github:close_issue:OWNER/REPO:#42` | 关闭 Issue 或 Pull Request |
| `@github:reopen_issue:OWNER/REPO:#42` | 重新打开 |
| `@github:review:OWNER/REPO:#42 approve <body>` | 提交评审：`approve`、`request_changes` 或 `comment` |
| `@github:merge:OWNER/REPO:#42 squash` | 合并：`merge`、`squash` 或 `rebase` |
| `@github:rerun_failed_jobs:OWNER/REPO:RUN_ID` | 重跑某次工作流中失败的任务 |
| `@github:dispatch_workflow:OWNER/REPO:WORKFLOW.yml:REF {…}` | 在指定 ref 上触发工作流，可附带 JSON 输入参数 |

## 其他已支持的应用

每个应用支持的全部动作都可在 **应用（Apps）** 面板及输入框自动补全中查看。目前已上线的应用包括：

| 应用 | ID | 事件 | 动作 |
| --- | --- | --- | --- |
| GitLab | `gitlab` | 合并请求、推送、流水线、Issue、评论、发布 | `read_issue`, `read_merge_request`, `comment`, `merge`, `retry_pipeline` |
| Bitbucket | `bitbucket` | Pull Request、评论、推送、构建 | `read_pull_request`, `comment` |
| Sentry | `sentry` | 新问题、回归、已解决、已指派、已忽略、告警、评论 | `read_issue`, `list_issues`, `resolve`, `unresolve`, `ignore` |
| Linear | `linear` | Issue、评论、项目 | `read_issue`, `comment`, `create_issue` |
| Jira | `jira` | Issue、评论 | `read_issue`, `comment`, `transition` |
| PagerDuty | `pagerduty` | 触发、确认、解决、状态更新 | `read_incident`, `acknowledge`, `resolve`, `note` |
| Opsgenie | `opsgenie` | 创建、确认、关闭、更新 | |
| Grafana | `grafana` | 告警触发、恢复 | |
| Vercel | `vercel` | 部署开始、成功、失败 | `redeploy` |
| Netlify | `netlify` | 部署开始、成功、失败 | |
| Cloudflare | `cloudflare` | 告警触发、恢复 | `query_logs`, `list_deployments`, `rollback` |
| Google Cloud | `gcp` | 监控事件触发、恢复 | 项目、Cloud Run、日志、指标、费用、API |
| CircleCI | `circleci` | 失败、成功 | |
| Buildkite | `buildkite` | 失败、通过 | |
| Stripe | `stripe` | 支付失败、争议、订阅变更。可直接通过 Stripe 授权，或接收自建 Webhook 的全部对象事件 | `accounts`, `list_events`, `get_event`, `list_payment_intents`, `get_payment_intent`, `list_invoices`, `get_invoice`, `list_subscriptions`, `get_subscription`, `list_disputes`, `get_dispute`（只读） |
| Google Docs, Drive & Sheets | `google` | | `read_doc`, `create_doc`, `append_doc`, `read_sheet`, `update_sheet`, `create_sheet`, `list_files` |
| Google Search Console | `googlesearchconsole` | | `query`, `inspect_url`、站点地图、属性、验证 |
| Google Calendar | `googlecalendar` | | `list_calendars`, `list_events`, `get_event`, `freebusy`, `create_event`, `update_event`, `delete_event`（写操作默认先询问；详见[指南](https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/connectors/google-calendar.md)） |
| Google Analytics | `googleanalytics` | | `list_properties`, `report` |
| Google Ads | `googleads` | | `list_accounts`, `read_account`, `query`, `validate_mutations`；`mutate`, `set_campaign_status`（默认先询问） |
| Google Play Console | `googleplay` | | `list_apps`, `tracks`, `release`, `base_plans`, `base_plan`, `one_time_product`, `api_operations`, `api_schema`, `api_read`, `api_plan`, `api_write`, `api_upload` |
| Google Business Profile | `googlebusinessprofile` | | `list_accounts`, `list_locations`, `performance`, `reviews`, `reply_review` |
| Google AdSense | `googleadsense` | | `list_accounts`, `list_sites`, `list_adunits`, `report`, `list_payments`, `list_alerts`, `list_policy_issues` |
| PageSpeed Insights | `pagespeed` | | `audit`, `field` |
| Bing Webmaster Tools | `bingwebmaster` | | `list_sites`, `traffic`, `queries`, `pages`, `crawl_stats`, `submit_urls`, `submit_sitemap`, `indexnow` |
| Yandex Webmaster | `yandexwebmaster` | | `list_hosts`, `summary`, `queries`, `recrawl` |
| Gmail | `gmail` | | `search`, `read`, `drafts`；`send`, `send_draft`, `reply`（默认每次发送均需 Space 管理员审批）。支持多个邮箱，每个邮箱仅限所属成员或 Agent 使用 |
| X | `x` | | `accounts`, `read_post`, `timeline`, `media_status`；`post`, `upload_video`, `publish_video`, `quote`（默认先询问）。需显式选择账号；引用转发需要 X Enterprise API 权限 |
| Notion | `notion` | | `read_page`, `append`, `create_page` |
| Slack | `slack` | 消息、表情回应 | `post` |
| App Store Connect | `appstoreconnect` | 版本状态、构建上传、TestFlight 审核与反馈 | `list_apps`, `status`, `builds`, `read_version`, `reviews`, `sales`, `review_messages`, `review_attachments`, `review_attachment`, `review_draft`, `edit_review_draft`, `send_review_draft`, `api_operations`, `api_schema`, `api_read`, `api_plan`, `api_write`, `web_session`, `create_app`, `privacy`, `set_privacy`, `read_app`, `create_version`, `set_metadata`, `set_build`, `submit`, `cancel_submission`, `subscriptions`, `submit_subscriptions`, `in_app_purchases`, `submit_in_app_purchases`, `release`, `pause_phased_release`, `resume_phased_release`, `complete_phased_release`, `reply_review`, `set_app_info`, `set_age_rating`, `set_price`, `set_availability`, `set_review_contact`, `upload_build`, `upload_screenshot`, `commit_upload`, `read_upload`, `delete_upload`, `build_uploads`, `screenshot_specs`, `screenshots`, `set_screenshots`, `declare_encryption`, `signing`, `register_bundle_id`, `enable_capability`, `create_certificate`, `read_certificate`, `create_profile`, `read_profile`, `testflight`, `feedback`, `crash_log`, `add_to_group`, `submit_beta_review`, `set_test_notes` |
| Discord | `discord` | | `post` |
| Telegram | `telegram` | 消息 | `send` |
| Feishu / Lark（飞书） | `feishu` | 消息 | `send` |
| Microsoft Teams | `teams` | 消息 | `post` |
| Google Chat | `googlechat` | 消息 | `post` |
| DingTalk（钉钉） | `dingtalk` | | `post`, `read`, `send` |
| WeCom（企业微信） | `wecom` | 消息 | `post`, `send` |
| Webhook | `webhook` | 任意带签名的 JSON 推送 | |
| OpenConnector | `openconnector` | | `search`, `run`：调用你自建 OpenConnector 运行时的动作 |

使用示例：

```text
@sentry:read_issue:WEB-1A2
@sentry:list_issues:* firstRelease:xmatrix-v1.2.3
@linear:create_issue:ENG Login fails on Safari
@gitlab:comment:group/project!5 Looks good.
@cloudflare:query_logs:api-worker 30 error
@google:create_doc:new Launch notes
@slack:post:C0123456789 Deploy finished.
```

## X 积分消耗

X 的付费动作需要 Pro 方案的 Space；无论是 Agent 执行还是成员执行或审批，X 的付费动作都会消耗 Space 的积分余额：

| 动作 | 积分 |
| --- | --- |
| 纯文本发帖 | 30 |
| 含链接、引用或媒体的帖子 | 400 |
| 读取帖子或时间线 | 每返回 1 条帖子消耗 10 |
| 查询账号资料（含连接与检查） | 每个账号消耗 20 |
| 上传媒体或查询状态 | 30 |

列出账号、发起审批请求以及刷新令牌均免费。被 X 拒绝或在发往 X 之前就失败的调用会自动退还积分。媒体上传及带链接/引用/媒体发帖的费率待 X 官方费用最终确认后可能会调整。

## 管理 Google Ads

在 **应用（Apps）** 中连接 Google Ads，在凭证区选择广告主客户 ID 并点击检查（Check）。此 Google 连接与 Analytics、Search Console 和 Drive 相互独立，所有读取与变更操作都无法跨广告主账户执行。

```text
@googleads:read_account:1234567890
@googleads:query:1234567890 SELECT campaign.id, campaign.name, campaign.status, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_7_DAYS LIMIT 50
@googleads:set_campaign_status:1234567890/987654321 {"status":"PAUSED"}
```

`validate_mutations` 可在不实际生效的前提下校验拟议的广告改动。`mutate` 支持一并创建或更新预算、广告系列、创意与定向，其中新建的广告系列必须处于暂停状态。`mutate` 和修改广告系列状态默认每次均需 Space 管理员审批。启用广告系列时，必须显式传入货币代码以及以整数 micros 表示的预期日均预算：

```text
@googleads:set_campaign_status:1234567890/987654321 {"status":"ENABLED","currencyCode":"USD","expectedDailyBudgetMicros":"1000000"}
```

1,000,000 micros 等于 1 个账户货币单位。日均预算并非硬性花费上限，Google 单日实际支出可能高于平均值。广告审核与投放均异步生效。若某次写操作结果未确认，请先查询确认状态再决定是否重试。完整配置与稳定验收契约见 [Google Ads 连接器文档](https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/connectors/google-ads.md)。

## 发布应用到 App Store

连接 App Store Connect 后，Agent 可以包办从上传构建到上架发布的全流程，并实时向你同步审核进展。在 **应用（Apps）** 中使用 App Store Connect API 密钥（用户和访问 → 集成）完成接入：填入 Key ID、Issuer ID 以及 `.p8` 文件内容，该密钥需具备 App Manager 角色。

```text
@appstoreconnect:subscribe:com.example.app
@appstoreconnect:create_version:com.example.app 1.2.0
@appstoreconnect:set_metadata:com.example.app 1.2.0 {"locale":"en-US","whatsNew":"Faster sync and two crash fixes."}
@appstoreconnect:set_build:com.example.app 1.2.0 412
@appstoreconnect:submit:com.example.app 1.2.0
@appstoreconnect:release:com.example.app 1.2.0
```

- `subscribe` 会自动在 Apple 侧为你注册 Webhook。此后，构建处理完成及每次版本状态变更（等待审核、审核中、被拒、获批、上架）都会实时推送到对话。你也可以用[程序](programs.md#来自已连接应用的事件)监听这些事件，让 Agent 自动接手处理拒审。
- `create_version` 默认以手动发布模式创建新版本；加上 `release=after_approval` 则在过审后由 Apple 自动发布。审核联系人与测试登录账号会自动沿用上一版本配置，不会暴露在对话中。
- `set_build` 在 Apple 处理完构建后为其绑定你上传的构建号。负责打包的 Agent 无需在本地存放 Apple 密钥即可上传构建，见下文[上传文件](#上传文件)。
- `submit` 将版本提交至 App Review。若因商店信息不完整被 Apple 拒收，回执会明确列出缺失项。
- `release` 发布已过审且等待开发者手动上架的版本。加上 `phased` 可启用 7 天分阶段发布；`pause_phased_release`、`resume_phased_release`、`complete_phased_release` 分别用于暂停、恢复和全量发布。发布动作本身不可撤回。Space 管理员可通过将 App Store Connect 权限设为“只读”来禁止写操作。

`@appstoreconnect:status:com.example.app` 可查看各版本当前状态，`reviews` 和 `reply_review` 用于查看和回复用户评价。其他平台的版本写作 `macos/1.2.0`、`tvos/1.2.0` 或 `visionos/1.2.0`。

新应用需先创建应用记录。在完成 Bundle ID 注册（见下文 `register_bundle_id`）且 Space 管理员于凭证区保存 Web 会话后，`create_app` 会创建应用记录及首个版本，`set_privacy` 用于填写并发布 App 隐私声明，`privacy` 用于回读当前声明。由于 Apple 官方 API 不提供这两项能力，它们通过已保存的 Web 会话经 App Store Connect 网页端执行：

```text
@appstoreconnect:create_app:com.example.app {"name":"Example","sku":"EXAMPLE","locale":"en-US","version":"1.0","platform":"ios"}
@appstoreconnect:set_privacy:com.example.app {"data":[{"category":"EMAIL_ADDRESS","purposes":["APP_FUNCTIONALITY"],"linked":true,"tracking":false}]}
```

`set_privacy` 会整体替换已有隐私声明；传入 `{"data":[]}` 表示应用不收集任何数据。与年龄分级一样，这些声明是你向 Apple 作出的合规承诺，请如实按应用实际情况填写。

首次提审前还需补齐几项基础信息。`@appstoreconnect:read_app:com.example.app` 会列出所有未填项，其中绝大多数都可由 Agent 代为填写：

```text
@appstoreconnect:set_app_info:com.example.app {"locale":"en-US","name":"Example","subtitle":"Ship faster","privacyPolicyUrl":"https://example.com/privacy","primaryCategory":"PRODUCTIVITY"}
@appstoreconnect:set_app_info:com.example.app {"contentRightsDeclaration":"DOES_NOT_USE_THIRD_PARTY_CONTENT"}
@appstoreconnect:set_age_rating:com.example.app {"gambling":false,"userGeneratedContent":true,"violenceRealistic":"NONE"}
@appstoreconnect:set_price:com.example.app free
@appstoreconnect:set_availability:com.example.app all
@appstoreconnect:set_review_contact:com.example.app 1.0.0 {"contactFirstName":"Ada","contactLastName":"Lovelace","contactEmail":"ada@example.com","contactPhone":"+1 555 0100"}
```

年龄分级问卷同样属于你对 Apple 的正式声明，系统不会为你预设默认值：请逐项作答，`read_app` 会把尚未填写的项标为 `null`。

### 回复 App Review

`review_messages` 可读取最新的审核沟通记录，包括话题 ID、消息 ID 与附件元数据。追加话题 ID 可查阅历史记录，追加消息 ID 可读取较长正文。配合已保存的 Web 会话，`review_attachments` 可列出附件，`review_attachment` 会返回一个带签名的限时下载链接，无需携带 Apple Cookie 或 API 密钥即可拉取文件。

`review_draft` 用于读取尚未发送的草稿及其摘要（digest）；`edit_review_draft` 创建草稿，或凭摘要更新、删除指定草稿；`send_review_draft` 精确发送该草稿并校验 Apple 侧生成的消息。在显式调用发送前草稿始终保持未发送状态，且发送回复不会重新提交应用审核。如发送结果不确定，请先检查沟通记录再重试。参数与限制详见[审核工作流文档](https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/connectors/app-store-connect-review.md)。

### 上传文件

构建包与截图分三步直传 Apple，文件本身全程不经过 xMatrix 服务器：

```text
@appstoreconnect:upload_build:com.example.app 1.2.0 412 Example.ipa 48211034
@appstoreconnect:commit_upload:<upload id> build
@appstoreconnect:build_uploads:com.example.app 412
```

1. `upload_build` 预约上传。传入包内的版本号与构建号、文件名及精确字节大小，回执会返回若干分片的上传方法、URL、字节范围及请求头。
2. 持有文件的机器上的 Agent 直接按要求将各分片字节发往 Apple 提供的限时 URL（仅对当前文件有效）。
3. `commit_upload` 通知 Apple 文件传输完成。随后 Apple 开始处理构建；已订阅对话会收到处理完成通知，`build_uploads` 可查看 Apple 发现的任何错误。

截图上传流程相同，上传后再绑定到商店页：

```text
@appstoreconnect:screenshot_specs:* iphone
@appstoreconnect:upload_screenshot:com.example.app home-6.9.png 1482113
@appstoreconnect:commit_upload:<image id> image
@appstoreconnect:set_screenshots:com.example.app 1.2.0 {"locale":"en-US","group":"<group>","images":["<image id>","<image id>"]}
```

`screenshot_specs` 列出 Apple 按设备系列划分的截图位及精确像素尺寸要求。`set_screenshots` 会让指定语言与分组按顺序展示你列出的图片，单张图片可跨语言复用。`screenshots` 查看当前版本已配置的截图。

若 Apple 要求声明出口合规信息，可用 `@appstoreconnect:declare_encryption:com.example.app 1.2.0 412 exempt` 针对该构建提交免检声明。

### 在无 Apple ID 的机器上完成签名

全新 Mac 或 CI 构建机上的 Agent 可直接通过连接器配置 App Store 签名。私钥在本机生成并始终留在本地，对外传输的只有证书签名请求（CSR）：

```text
@appstoreconnect:signing:com.example.app
@appstoreconnect:register_bundle_id:com.example.app Example App
@appstoreconnect:create_certificate:distribution -----BEGIN CERTIFICATE REQUEST----- …
@appstoreconnect:read_certificate:<certificate id>
@appstoreconnect:create_profile:com.example.app <certificate id>
@appstoreconnect:read_profile:<profile id>
```

`signing` 查看当前已有资产。每个开发者团队可创建的发布证书数量有限，因此仅在没有任何机器保留现有证书私钥时才新建证书。`enable_capability` 可为 Bundle ID 开启如 `PUSH_NOTIFICATIONS` 等能力，开启后再生成描述文件（profile）。

### TestFlight

```text
@appstoreconnect:testflight:com.example.app
@appstoreconnect:add_to_group:com.example.app 1.2.0 412 Early Access
@appstoreconnect:set_test_notes:com.example.app 1.2.0 412 en-US Try the new sync.
@appstoreconnect:submit_beta_review:com.example.app 1.2.0 412
@appstoreconnect:feedback:com.example.app
@appstoreconnect:crash_log:<feedback id>
```

在订阅类型中加入 `feedback` 后，Agent 就能自动跟进测试人员的反馈：`feedback` 列出评论及对应的设备、系统与构建号，`feedback:… crashes` 搭配 `crash_log` 则能直接拉取崩溃日志。

### 当版本被 App Review 拒审时

对话会第一时间收到拒审通知。`@appstoreconnect:review_messages:com.example.app` 可借助已保存的 Web 会话读取拒审理由与审核员留言。在 xMatrix 应用中点击“登录 App Store Connect”会打开 Apple 官方登录页并保存会话。`review_attachments` 列出相关附件，`review_attachment` 返回无需凭证即可下载的限时链接。先用 `review_draft` 查看草稿，用 `edit_review_draft` 编辑未发送回复，再用 `send_review_draft` 携带精确 ID 与摘要发出。发送回复本身不会重新提审。修复问题后，调用 `submit` 即可将同一提审单重新送审；或先 `cancel_submission` 再 `submit` 创建全新提审单。

应用的首次订阅商品会随应用版本一并审核。`subscriptions` 列出订阅及其审核状态；`submit_subscriptions` 会将所有就绪项（或指定的产品 ID）加入提审草稿，随下一次版本 `submit` 一同送审。一次性内购项目（消耗型如积分包、非消耗型、非续期订阅）单独管理：`in_app_purchases` 列出类型与审核状态，`submit_in_app_purchases` 将其加入草稿，随下一次版本提审一并提交。

Apple 仍要求账号登录、协议签署、银行税务以及私有审核测试账号凭证由账号所有者自行保管。已保存的 Web 会话主要用于创建应用记录、配置 App 隐私及回复审核。

### 其他 App Store Connect 资源

`api_operations:* <resource>` 可检索固定版本的官方 API 接口，`api_schema:<operation or schema>` 查看精确参数定义。`api_read` 覆盖订阅/内购配置、TestFlight 测试员与分组、定价/优惠、通知、资产、设备、团队权限和报表等其他资源；涉及个人或财务数据时请使用私有读取。执行写操作时，`api_plan` 会先校验预期请求并返回摘要而不会改动 Apple 侧数据；`api_write` 在核对摘要与目标当前状态后执行该请求。两者均不接受登录凭据。对于结果不明确的写操作（尤其是创建新资源时），重试前务必先核查状态。

## Agent 如何调用应用

Agent 通过在对话中发送可见消息调用应用，与成员手动输入指令遵循完全一致的动作与权限规则。`xmatrix connector list` 查看当前已连接应用及可用命令，`xmatrix send <channel-id> "<command>"` 发送指令，执行结果会直接回复在该消息下。你无需在 Agent 端做任何额外配置。

Gmail 的搜索与读取会把邮件内容写入对话回执，且执行历史会保存有限摘要，所有有权查看该对话的成员都能看到这些内容。可使用 `@gmail:search:* is:unread newer_than:1h` 搜索，或将 `*` 替换为具体已连接邮箱地址。不存在仅调用者可见的邮件结果或连接器 MCP。

请勿使用这些动作获取必须保密的登录验证码或凭证，系统也不提供将 Gmail 邮件直接转存为 Space 密钥的动作。对于经授权的手动登录场景，Agent 可运行 `xmatrix request secret-add <fresh-alias> --env QA_LOGIN_CODE --reason "QA login"` 发起请求；由 Space 管理员在请求卡片中填入验证码（切勿发在聊天里）。随后 Agent 使用 `xmatrix secret exec --secret <fresh-alias>=QA_LOGIN_CODE -- <login-command>` 将其注入到不会打印、截屏、追踪或记录日志的进程中。这种手动录入方式不会验证连接器邮件送达或自动登录；且一旦敏感内容已出现在频道回执中，事后转存密钥无法撤回此前的暴露。

## 限制操作权限

Gmail 的发送与回复默认采用 **先询问（Ask）** 模式。每次请求都会进入对话的 **待审批（Pending approvals）**，清晰展示发件人、收件人、主题与正文，由 Space 管理员选择 **仅允许本次（Allow once）** 或 **拒绝（Disallow）**。批准一封邮件不会自动批准下一封；等待期间不会发出任何邮件。

在 **应用 → Gmail → 权限（Apps → Gmail → Permissions）** 中，可选择 **只读（Read only）**、**先询问（Ask first）** 或 **读写（Read and write）**。这一设置对该连接在所有对话中统一生效：三种模式均允许读取，“先询问”会拦截每次变更等待审批，“读写”则直接执行变更。不设分频道规则或按单个动作细分设置。Calendar 默认为“读写”；Gmail、Google Ads、X 和 Linear 默认为“先询问”；GitHub 支持“只读”或“读写”。
