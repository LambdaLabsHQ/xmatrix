---
title: "讓 AI Agent 整合 GitHub、Sentry、Linear 與 Slack · xMatrix 文件"
description: "將 GitHub、Sentry、Linear、Slack 等 30 多個應用程式的事件帶進對話，讓團隊成員與 Agent 用一行指令安全操作。"
---

# 已連結應用程式

已連結應用程式（Connected apps）讓外部服務與 Space 雙向整合：外部事件會直接化作訊息進入對話，而團隊成員與 Agent 也能直接透過訊息對這些服務執行操作。

Space 管理員可以在應用程式的 **Apps** 畫面設定連線。部分服務支援直接透過官方帳號登入授權，另一些則需填入 Webhook URL 或 API Token。所有憑證皆以 Space 為單位加密保存，設定後絕不會再次明文顯示。

## 指令格式

```text
@<app>:<action>:<target> <text>
```

- `<app>` 是應用程式 ID，例如 `github` 或 `sentry`。
- `<action>` 是該應用程式提供的操作名稱，採用小寫與底線命名。
- `<target>` 是操作對象，例如儲存庫、Issue 或專案；不需要指定對象的操作請填 `*`。
- `<text>` 是操作所需的附加內容，例如留言本文、標題、選項或 JSON 物件。

指令必須位於訊息開頭，且每則訊息只能包含一個指令。第一行之後的所有內容皆屬於指令本文。輸入 `@` 與應用程式名稱時，編輯器會自動引導你選擇操作與對象。

每一次執行指令都會在對話中留下一筆包含執行結果的回執（receipt）。

## 切換帳號、暫停與移除

在已連結應用程式的設定頁面中，你可以管理該連線帳號：

- **Switch account（切換帳號）**可將應用程式切換至另一個帳號。採用登入授權的服務會開啟對方的帳號選擇器（Google 每次都會詢問要使用哪個帳號），在新帳號完成登入前，原本的連線仍會保持運作。採用手動貼上憑證的服務則會跳轉至憑證區，填入新帳號資料並通過供應商驗證後才會覆蓋舊值。Space 管理員也可以在欄位選擇 **Use a saved secret**：由 Hub 直接複製該 Space 機密的最新值到連線並進行驗證，全程不顯示明文，且每次複製都會留存於機密稽核紀錄中。
- **Pause（暫停）**會停止所有指令執行與頻道事件推送，但保留原有的登入憑證。點擊 **Resume（恢復）**即可直接沿用原帳號重新啟用，無需重新登入。
- **Remove（移除）**會在二次確認後刪除整個連線、已儲存的憑證以及相關的頻道訂閱。

Google 相關應用程式不支援暫停：只要停止服務，xMatrix 就會刪除該 Google 登入憑證，因此介面提供的是 **Sign out（登出）**。支援多帳號清單的應用程式（GitHub、Gmail、Stripe、Cloudflare、X）則可以直接在清單中個別新增或移除帳號。

## 事件訂閱

將對話訂閱至某個外部來源後，該來源的事件便會自動張貼至此對話：

```text
@github:subscribe:acme/web
@github:subscribe:acme/web pulls checks
@github:subscribe:acme/web:#42
@sentry:subscribe:web issue.created issue.regressed
@linear:subscribe:*
@github:unsubscribe:acme/web checks
```

對象後方的關鍵字用來篩選要推播的事件類型。若不填則套用該應用的預設類型，`all` 代表訂閱全部類型。

GitHub 支援的類型包括 `issues`、`pulls`、`comments`、`reviews`、`commits`、`checks`、`status` 與 `releases`。加上 `except:LOGIN` 可排除特定 GitHub 帳號產生的活動（包含該帳號開啟的 Issue、PR 及其他事件）。例如 `@github:subscribe:acme/web issues pulls except:octocat` 會推送除了 `octocat` 以外所有人的 Issue 與 PR；`@github:unsubscribe:acme/web except:octocat` 則會取消這項排除條件。由 Agent 開啟的 Pull Request 會自動訂閱回該 Agent 所在的對話，因此 CI 結果、審查意見與合併狀態都會直接回報到當初派工的地方。

外部事件也能自動啟動 Agent：只要在頁面上撰寫監聽事件的[程式](programs.md#events-from-connected-apps)即可。

## GitHub

連結 GitHub 也是啟用 `repo:` 啟動條件的關鍵：連線後，Space 就能將底下儲存庫設為啟動目標，並讓 Agent 透過 Space 的 GitHub 連線執行 git push。

| 指令 | 效果 |
| --- | --- |
| `@github:subscribe:OWNER/REPO [kinds]` | 在此對話推送儲存庫事件 |
| `@github:subscribe:OWNER/REPO:#42` | 追蹤單一 Issue 或 Pull Request |
| `@github:unsubscribe:OWNER/REPO [kinds]` | 取消訂閱 |
| `@github:comment:OWNER/REPO:#42 <body>` | 在 Issue 或 Pull Request 留言 |
| `@github:create_issue:OWNER/REPO <title>` | 建立新 Issue；後續各行為內文 |
| `@github:close_issue:OWNER/REPO:#42` | 關閉 Issue 或 Pull Request |
| `@github:reopen_issue:OWNER/REPO:#42` | 重新開啟 |
| `@github:review:OWNER/REPO:#42 approve <body>` | 送出審查：`approve`、`request_changes` 或 `comment` |
| `@github:merge:OWNER/REPO:#42 squash` | 合併 PR：`merge`、`squash` 或 `rebase` |
| `@github:rerun_failed_jobs:OWNER/REPO:RUN_ID` | 重跑 workflow 失敗的工作項目 |
| `@github:dispatch_workflow:OWNER/REPO:WORKFLOW.yml:REF {…}` | 在指定 ref 觸發 workflow，可選填 JSON 輸入參數 |

## 其他應用程式

每個應用程式支援的完整操作都會顯示在 **Apps** 面板與訊息編輯器中。目前支援的服務如下：

| 應用程式 | ID | 事件 | 操作 |
| --- | --- | --- | --- |
| GitLab | `gitlab` | Merge requests、pushes、pipelines、issues、comments、releases | `read_issue`、`read_merge_request`、`comment`、`merge`、`retry_pipeline` |
| Bitbucket | `bitbucket` | Pull requests、comments、pushes、builds | `read_pull_request`、`comment` |
| Sentry | `sentry` | 新 Issue、回歸異常、已解決、已指派、已忽略、告警、留言 | `read_issue`、`list_issues`、`resolve`、`unresolve`、`ignore` |
| Linear | `linear` | Issues、comments、projects | `read_issue`、`comment`、`create_issue` |
| Jira | `jira` | Issues、comments | `read_issue`、`comment`、`transition` |
| PagerDuty | `pagerduty` | 觸發、確認、解決、更新 | `read_incident`、`acknowledge`、`resolve`、`note` |
| Opsgenie | `opsgenie` | 建立、確認、關閉、更新 | |
| Grafana | `grafana` | 觸發告警、恢復正常 | |
| Vercel | `vercel` | 部署開始、成功、失敗 | `redeploy` |
| Netlify | `netlify` | 部署開始、成功、失敗 | |
| Cloudflare | `cloudflare` | 告警觸發、恢復正常 | `query_logs`、`list_deployments`、`rollback` |
| Google Cloud | `gcp` | Monitoring 事件觸發、恢復正常 | 專案、Cloud Run、日誌、指標、費用、API |
| CircleCI | `circleci` | 失敗、成功 | |
| Buildkite | `buildkite` | 失敗、通過 | |
| Stripe | `stripe` | 付款失敗、爭議款項與訂閱異動。可透過 Connect with Stripe 連線，或自建 Webhook 接收物件所有事件 | |
| Google Docs, Drive & Sheets | `google` | | `read_doc`、`create_doc`、`append_doc`、`read_sheet`、`update_sheet`、`create_sheet`、`list_files` |
| Google Search Console | `googlesearchconsole` | | `query`、`inspect_url`、sitemaps、資源屬性、驗證 |
| Google Calendar | `googlecalendar` | | `list_calendars`、`list_events`、`get_event`、`freebusy`、`create_event`、`update_event`、`delete_event`（寫入操作預設先詢問；詳見[指南](https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/connectors/google-calendar.md)） |
| Google Analytics | `googleanalytics` | | `list_properties`、`report` |
| Google Ads | `googleads` | | `list_accounts`、`read_account`、`query`、`validate_mutations`；`mutate`、`set_campaign_status`（預設先詢問） |
| Google Play Console | `googleplay` | | `list_apps`、`tracks`、`release`、`base_plans`、`base_plan`、`one_time_product`、`api_operations`、`api_schema`、`api_read`、`api_plan`、`api_write`、`api_upload` |
| Google Business Profile | `googlebusinessprofile` | | `list_accounts`、`list_locations`、`performance`、`reviews`、`reply_review` |
| Google AdSense | `googleadsense` | | `list_accounts`、`list_sites`、`list_adunits`、`report`、`list_payments`、`list_alerts`、`list_policy_issues` |
| PageSpeed Insights | `pagespeed` | | `audit`、`field` |
| Bing Webmaster Tools | `bingwebmaster` | | `list_sites`、`traffic`、`queries`、`pages`、`crawl_stats`、`submit_urls`、`submit_sitemap`、`indexnow` |
| Yandex Webmaster | `yandexwebmaster` | | `list_hosts`、`summary`、`queries`、`recrawl` |
| Gmail | `gmail` | | `search`、`read`；`send`、`reply`（預設每次都需 Space 管理員核准）。支援多個信箱，每個信箱僅供其所屬成員或 Agent 使用 |
| X | `x` | | `accounts`、`read_post`、`timeline`、`media_status`；`post`、`upload_video`、`publish_video`、`quote`（預設先詢問）。需明確指定帳號；引用貼文需 X Enterprise API 權限 |
| Notion | `notion` | | `read_page`、`append`、`create_page` |
| Slack | `slack` | 訊息、表情反應 | `post` |
| App Store Connect | `appstoreconnect` | 版本狀態、建置上傳、TestFlight 審查與回饋 | `list_apps`、`status`、`builds`、`read_version`、`reviews`、`sales`、`review_messages`、`review_attachments`、`review_attachment`、`review_draft`、`edit_review_draft`、`send_review_draft`、`api_operations`、`api_schema`、`api_read`、`api_plan`、`api_write`、`web_session`、`create_app`、`privacy`、`set_privacy`、`read_app`、`create_version`、`set_metadata`、`set_build`、`submit`、`cancel_submission`、`subscriptions`、`submit_subscriptions`、`in_app_purchases`、`submit_in_app_purchases`、`release`、`pause_phased_release`、`resume_phased_release`、`complete_phased_release`、`reply_review`、`set_app_info`、`set_age_rating`、`set_price`、`set_availability`、`set_review_contact`、`upload_build`、`upload_screenshot`、`commit_upload`、`read_upload`、`delete_upload`、`build_uploads`、`screenshot_specs`、`screenshots`、`set_screenshots`、`declare_encryption`、`signing`、`register_bundle_id`、`enable_capability`、`create_certificate`、`read_certificate`、`create_profile`、`read_profile`、`testflight`、`feedback`、`crash_log`、`add_to_group`、`submit_beta_review`、`set_test_notes` |
| Discord | `discord` | | `post` |
| Telegram | `telegram` | 訊息 | `send` |
| Feishu / Lark | `feishu` | 訊息 | `send` |
| Microsoft Teams | `teams` | 訊息 | `post` |
| Google Chat | `googlechat` | 訊息 | `post` |
| DingTalk | `dingtalk` | | `post`、`read`、`send` |
| WeCom | `wecom` | 訊息 | `post`、`send` |
| Webhook | `webhook` | 任何附帶簽章的 JSON 推播 | |
| OpenConnector | `openconnector` | | `search`、`run`：執行你自建 OpenConnector 執行環境的操作 |

常用範例：

```text
@sentry:read_issue:WEB-1A2
@sentry:list_issues:* firstRelease:xmatrix-v1.2.3
@linear:create_issue:ENG Login fails on Safari
@gitlab:comment:group/project!5 Looks good.
@cloudflare:query_logs:api-worker 30 error
@google:create_doc:new Launch notes
@slack:post:C0123456789 Deploy finished.
```

## X 點數計費

在 Pro 方案中，付費的 X 操作會扣除 Space 的點數餘額，不論是由 Agent 執行，還是由團隊成員執行或核准皆同。

| 操作 | 點數 |
| --- | --- |
| 純文字貼文 | 30 |
| 含網址、引用或媒體的貼文 | 400 |
| 讀取貼文或時間軸 | 每回傳 1 則貼文 10 點 |
| 查詢個人檔案（包含 Connect 與 Check） | 每個檔案 20 點 |
| 媒體上傳或狀態查詢 | 30 |

列出帳號、核准請求與更新權杖均為免費。遭 X 拒絕或尚未送達 X 就失敗的呼叫皆會自動退還點數。媒體上傳以及含網址、引用或媒體貼文的費率，可能會在 X 官方收費定案後隨之調整。

## 管理 Google Ads

在 **Apps** 中連結 Google Ads，於 Credentials 選擇廣告主客戶 ID 並執行 Check。這項 Google 連線與 Analytics、Search Console 及 Drive 各自獨立，讀取或異動操作無法跨廣告主帳戶存取。

```text
@googleads:read_account:1234567890
@googleads:query:1234567890 SELECT campaign.id, campaign.name, campaign.status, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_7_DAYS LIMIT 50
@googleads:set_campaign_status:1234567890/987654321 {"status":"PAUSED"}
```

`validate_mutations` 可預先驗證擬議的廣告異動而不實際套用。`mutate` 能一次建立或更新預算、廣告活動、素材與受眾設定；新建的廣告活動預設必須為暫停狀態。`mutate` 與變更廣告活動狀態預設每次都需要 Space 管理員核准。若要啟用某個廣告活動，必須明確提供幣別以及預期當下的平均每日預算（以整數微單位 micros 表示）：

```text
@googleads:set_campaign_status:1234567890/987654321 {"status":"ENABLED","currencyCode":"USD","expectedDailyBudgetMicros":"1000000"}
```

一百萬 micros 等於該帳戶幣別的 1 元。平均每日預算並非絕對花費上限，Google 單日實際花費可能會超過平均值。原生廣告審查與投放屬於非同步流程；若某次寫入結果尚未確認，重試前請先查詢最新狀態。完整設定與驗收規格請參閱 [Google Ads 連接器文件](https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/connectors/google-ads.md)。

## 將應用程式上架至 App Store

連結 App Store Connect 後，Agent 可以從上傳建置檔一路完成送審與上架，並即時回報審查結果。在 **Apps** 頁面使用 App Store Connect API 金鑰（Users and Access → Integrations）完成連線，填入 Key ID、Issuer ID 與 `.p8` 檔案內容；該金鑰需具備 App Manager 角色權限。

```text
@appstoreconnect:subscribe:com.example.app
@appstoreconnect:create_version:com.example.app 1.2.0
@appstoreconnect:set_metadata:com.example.app 1.2.0 {"locale":"en-US","whatsNew":"Faster sync and two crash fixes."}
@appstoreconnect:set_build:com.example.app 1.2.0 412
@appstoreconnect:submit:com.example.app 1.2.0
@appstoreconnect:release:com.example.app 1.2.0
```

- `subscribe` 會自動替你在 Apple 端註冊應用程式的 Webhook。對話隨後便會即時收到建置處理完成通知，以及每次版本狀態變更：等待審查、審查中、遭拒、核准、已上架。你可以搭配[程式](programs.md#events-from-connected-apps)監聽這些事件，在遭拒時自動叫醒 Agent 處理。
- `create_version` 會建立下一個手動發布的版本；加上 `release=after_approval` 則會在審查通過後立即自動上架。App Review 聯絡人與測試帳號資訊會從上一版本自動沿用，不會暴露在對話訊息中。
- `set_build` 在 Apple 處理完建置後指定你要綁定的建置編號。負責編譯的 Agent 即使主機上沒有任何 Apple 金鑰也能完成上傳：請見下方[上傳檔案](#uploading-files)。
- `submit` 將版本送交 App Review。若因商品頁資訊缺漏而遭 Apple 拒絕，回執會明確列出缺少的項目。
- `release` 發布已通過審查、等待開發者手動上架的版本。加上 `phased` 可啟用 7 天分階段發布；`pause_phased_release` 暫停、`resume_phased_release` 恢復、`complete_phased_release` 立即推送給所有使用者。一旦發布即無法復原。Space 管理員可以將 App Store Connect 權限設為 Read only 來鎖定寫入操作。

`@appstoreconnect:status:com.example.app` 可檢視所有版本的目前狀態，`reviews` 與 `reply_review` 則用於處理使用者評論。其他平台的版本可寫為 `macos/1.2.0`、`tvos/1.2.0` 或 `visionos/1.2.0`。

全新的應用程式需要先建立記錄。完成 Bundle ID 註冊（見下方 `register_bundle_id`）且 Space 管理員在 Credentials 儲存 Web 工作階段後，`create_app` 即可建立 App 記錄與首個版本，`set_privacy` 可填寫並發布 App 隱私權問卷（`privacy` 用於讀回目前填答）。由於 Apple 官方 API 未提供這兩項功能，兩者皆會透過已儲存的 Web 工作階段操作 App Store Connect 網站完成：

```text
@appstoreconnect:create_app:com.example.app {"name":"Example","sku":"EXAMPLE","locale":"en-US","version":"1.0","platform":"ios"}
@appstoreconnect:set_privacy:com.example.app {"data":[{"category":"EMAIL_ADDRESS","purposes":["APP_FUNCTIONALITY"],"linked":true,"tracking":false}]}
```

`set_privacy` 會覆蓋該 App 先前的所有隱私權填答；填入 `{"data":[]}` 代表不蒐集任何資料。與年齡分級相同，這些內容屬於你向 Apple 提出的正式聲明，請務必依應用程式實際行為據實填寫。

首次送審前還需要完成幾項一次性基本設定。執行 `@appstoreconnect:read_app:com.example.app` 可檢查尚缺哪些欄位，其中多數都能由 Agent 直接填寫：

```text
@appstoreconnect:set_app_info:com.example.app {"locale":"en-US","name":"Example","subtitle":"Ship faster","privacyPolicyUrl":"https://example.com/privacy","primaryCategory":"PRODUCTIVITY"}
@appstoreconnect:set_app_info:com.example.app {"contentRightsDeclaration":"DOES_NOT_USE_THIRD_PARTY_CONTENT"}
@appstoreconnect:set_age_rating:com.example.app {"gambling":false,"userGeneratedContent":true,"violenceRealistic":"NONE"}
@appstoreconnect:set_price:com.example.app free
@appstoreconnect:set_availability:com.example.app all
@appstoreconnect:set_review_contact:com.example.app 1.0.0 {"contactFirstName":"Ada","contactLastName":"Lovelace","contactEmail":"ada@example.com","contactPhone":"+1 555 0100"}
```

年齡分級問卷同樣是你對 Apple 的正式聲明，系統不會代填任何預設值；請逐項填入所有題目，`read_app` 會將尚未填答的欄位標示為 `null`。

### 回覆 App Review 審查訊息

`review_messages` 會讀取最新的審查討論串，包含討論串 ID、訊息 ID 與附件中繼資料。加上討論串 ID 可查詢較舊的討論串，加上訊息 ID 則可讀取完整長文。搭配已儲存的 Web 工作階段，`review_attachments` 會列出附件清單，而 `review_attachment` 會回傳一組有時效的簽章下載網址，不需 Apple Cookie 或 API 金鑰即可直接下載檔案。

`review_draft` 用來讀取尚未送出的草稿與其摘要值（digest）。`edit_review_draft` 可建立新草稿，或搭配摘要值更新／刪除既有草稿。`send_review_draft` 會送出該份確切草稿並確認 Apple 端已成立該則訊息。在執行送出動作前，草稿都不會寄出；送出回覆本身也不會重新送審應用程式。若送出狀態不明確，重試前請先檢查討論串內容。完整指令參數與限制請參閱 [App Review 回覆流程文件](https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/connectors/app-store-connect-review.md)。

### 上傳檔案

建置檔與螢幕截圖透過三個步驟直接傳給 Apple，檔案本身完全不會經過 xMatrix 伺服器：

```text
@appstoreconnect:upload_build:com.example.app 1.2.0 412 Example.ipa 48211034
@appstoreconnect:commit_upload:<upload id> build
@appstoreconnect:build_uploads:com.example.app 412
```

1. `upload_build` 向 Apple 預約上傳空間，需填入檔案內部的版本號與建置編號、檔名以及精確的位元組大小。回執會列出一個或多個分塊：HTTP 方法、目標網址、位元組範圍與標頭。
2. 持有檔案主機上的 Agent 直接將每個分塊位元組連同指定標頭傳送至 Apple 網址。這些網址由 Apple 核發、有時效限制，且僅適用於這一個檔案。
3. `commit_upload` 通知 Apple 檔案上傳完畢。Apple 隨即開始處理建置；已訂閱的對話會在處理完成時收到通知，也可以用 `build_uploads` 查看 Apple 回報的任何錯誤。

螢幕截圖的上傳方式完全相同，完成後再設定至商品頁：

```text
@appstoreconnect:screenshot_specs:* iphone
@appstoreconnect:upload_screenshot:com.example.app home-6.9.png 1482113
@appstoreconnect:commit_upload:<image id> image
@appstoreconnect:set_screenshots:com.example.app 1.2.0 {"locale":"en-US","group":"<group>","images":["<image id>","<image id>"]}
```

`screenshot_specs` 會依裝置類型列出 Apple 的截圖版位群組及精確像素規格。`set_screenshots` 會將該語系與群組的圖片設定為指定順序清單，同一張圖片可跨語系重複使用。`screenshots` 可查看版本目前已設定的截圖。

若 Apple 要求填寫出口合規（export compliance）聲明，可執行 `@appstoreconnect:declare_encryption:com.example.app 1.2.0 412 exempt`。

### 在沒有 Apple ID 的主機上完成簽章設定

新配置的 Mac 或 CI runner 上的 Agent 可以透過連接器完成 App Store 簽章設定。私鑰會在該主機本機生成且絕不離機，僅傳送憑證簽章請求（CSR）：

```text
@appstoreconnect:signing:com.example.app
@appstoreconnect:register_bundle_id:com.example.app Example App
@appstoreconnect:create_certificate:distribution -----BEGIN CERTIFICATE REQUEST----- …
@appstoreconnect:read_certificate:<certificate id>
@appstoreconnect:create_profile:com.example.app <certificate id>
@appstoreconnect:read_profile:<profile id>
```

`signing` 會顯示目前已有的簽章資源。由於每個開發者團隊的發布憑證數量有限，僅在沒有任何主機仍保有舊憑證私鑰時才建議建立新憑證。`enable_capability` 可為 Bundle ID 開啟如 `PUSH_NOTIFICATIONS` 等功能，啟用後再建立 Provisioning Profile 即可。

### TestFlight

```text
@appstoreconnect:testflight:com.example.app
@appstoreconnect:add_to_group:com.example.app 1.2.0 412 Early Access
@appstoreconnect:set_test_notes:com.example.app 1.2.0 412 en-US Try the new sync.
@appstoreconnect:submit_beta_review:com.example.app 1.2.0 412
@appstoreconnect:feedback:com.example.app
@appstoreconnect:crash_log:<feedback id>
```

在對話訂閱中加入 `feedback` 類型，Agent 就能即時接手測試人員的回報：`feedback` 會列出回饋內容、裝置、系統版本與建置編號，而 `feedback:… crashes` 搭配 `crash_log` 則可取得當機報告詳情。

### 當 App Review 退件時

對話會即時收到退件通知。執行 `@appstoreconnect:review_messages:com.example.app` 即可透過已儲存的 Web 工作階段讀取退件原因與審查人員留言。在 xMatrix 應用程式中點擊「Sign in to App Store Connect」會開啟 Apple 官方登入頁面並保存工作階段。`review_attachments` 可列出相關附件，`review_attachment` 則回傳無需憑證即可下載的限時網址。讀取 `review_draft`、以 `edit_review_draft` 編輯未送出草稿，再用 `send_review_draft` 搭配確切的草稿 ID 與摘要值送出。送出回覆不會重新提交版本；修正問題後，執行 `submit` 可將同一送審項目重新送交審查，或先執行 `cancel_submission` 再 `submit` 建立新的送審。

App 的首批訂閱項目必須與應用程式版本一併送審。`subscriptions` 會列出各訂閱項目的審查狀態；`submit_subscriptions` 會將所有就緒項目（或指定的產品 ID）加入送審草稿，待下次版本 `submit` 時一併提交。一次性 App 內購買項目（包含點數包等消耗型、非消耗型及非續訂訂閱）為獨立流程：`in_app_purchases` 可查詢類型與狀態，`submit_in_app_purchases` 則會將就緒項目加入送審草稿，隨版本一同送審。

Apple 仍要求登入認證、合約簽署、銀行／稅務設定以及私人測試帳號憑證由帳號擁有者本人管理。已儲存的 Web 工作階段支援建立 App 記錄、填寫 App 隱私權與回覆審查訊息。

### 其他 App Store Connect 資源

`api_operations:* <resource>` 可搜尋鎖定版本的官方 API 操作清單，`api_schema:<operation or schema>` 則顯示精確的參數結構。`api_read` 涵蓋其他所有資源，包含訂閱／IAP 設定、TestFlight 測試人員與群組、定價與優惠、通知、素材、裝置、團隊權限與報表。涉及個人或財務數據時請使用私人讀取。進行寫入前，`api_plan` 會驗證請求並回傳摘要值而不改動 Apple 端資料；`api_write` 則在確認摘要值與目標現況相符後才會實際執行。這兩個操作均不接受登入機密。結果不明確的寫入（尤其是新建資源時）在重試前必須先查詢確認。

## Agent 與外部應用程式

Agent 透過對話中公開可見的訊息操作外部應用程式，適用與團隊成員完全相同的指令語法與權限規則。`xmatrix connector list` 會列出已連結的應用程式與支援指令，`xmatrix send <channel-id> "<command>"` 即可送出操作並在同一訊息收到結果回覆，無需在 Agent 端額外設定任何項目。

Gmail 的搜尋（`search`）與讀取（`read`）會將信件內容張貼至對話回執，執行紀錄也會保存有上限的摘要節錄；所有能閱讀該對話的成員都會看到這些內容。你可以用 `@gmail:search:* is:unread newer_than:1h` 搜尋，或將 `*` 換成特定的已連結信箱地址。系統不提供連接器專用的 MCP 或僅限呼叫者可見的私密讀信結果。

請勿使用這些操作來讀取不可外洩到訊息中的登入驗證碼或憑證。系統也沒有將 Gmail 內容直接轉存為 Space 機密的功能。若需進行經授權的手動登入，Agent 應改用 `xmatrix request secret-add <fresh-alias> --env QA_LOGIN_CODE --reason "QA login"` 提出申請，由 Space 管理員在專屬請求卡片中輸入驗證碼（絕不貼入聊天室）。接著 Agent 再以 `xmatrix secret exec --secret <fresh-alias>=QA_LOGIN_CODE -- <login-command>` 將其注入執行程序，並確保該程序不會把值印出或暴露在截圖、追蹤紀錄或請求日誌中。這種手動機密注入方式不代表驗證過信箱收信或自動登入；且若先前已經在頻道回執讀出明文，事後再存入機密並無法撤銷先前的揭露。

## 限制操作權限

Gmail 的寄信（`send`）與回信（`reply`）預設為 **Ask（先詢問）**。每一筆請求都會出現在對話的 **Pending approvals（待核准）** 中，清楚顯示寄件者、收件者、主旨與內文。由 Space 管理員決定 **Allow once（允許一次）** 或 **Disallow（拒絕）**。核准一封信不會自動放行下一封；等待審核期間系統不會寄出任何郵件。

前往 Apps → Gmail → Permissions，你可以切換 **Read only（唯讀）**、**Ask first（寫入前先詢問）** 或 **Read and write（讀寫皆允許）**。這項設定套用於該連線在所有對話中的行為：三種模式都允許讀取，Ask 會逐筆暫存變更待核准，Read and write 則直接執行變更。目前不提供針對單一頻道或單一操作的個別規則。Calendar 預設為 Read and write；Gmail、Google Ads、X 與 Linear 預設為 Ask first；GitHub 則支援 Read only 或 Read and write。
