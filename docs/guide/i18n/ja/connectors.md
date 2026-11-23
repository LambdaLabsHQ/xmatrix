---
title: "AI エージェント向け GitHub・Sentry・Linear・Slack 連携 · xMatrix ドキュメント"
description: "GitHub、Sentry、Linear、Slack など 30 以上のアプリからのイベントを会話に届け、人とエージェントが 1 行コマンドで安全に操作できます。"
---

# 連携アプリ

連携アプリ（Connected apps）は、外部サービスと Space を双方向に結び付けます。外部サービスのイベントがメッセージとして会話に届き、人とエージェントはメッセージから外部サービスを操作できます。

Space 管理者はアプリの **Apps** 画面から各サービスを連携します。サービスのサインイン画面で連携するものもあれば、Webhook URL や API トークンを入力するものもあります。認証情報は Space 単位で保存され、保存後に再表示されることはありません。

## コマンド構文

```text
@<app>:<action>:<target> <text>
```

- `<app>` は `github` や `sentry` などのアプリ ID です。
- `<action>` はそのアプリのアクション名（小文字とアンダースコア）です。
- `<target>` は操作対象（リポジトリ、Issue、プロジェクトなど）です。対象不要のアクションでは `*` を指定します。
- `<text>` はコメント本文、タイトル、オプション、JSON オブジェクトなどアクションに必要な引数です。

コマンドはメッセージの先頭に書く必要があり、1 通のメッセージで実行できるのは 1 コマンドのみです。2 行目以降はテキスト本文として扱われます。コンポーザーで `@` とアプリ名を入力すると、アクションやターゲットが順に補完されます。

すべてのコマンドは、実行結果を示すレシートを会話内に残します。

## アカウント切り替え・一時停止・削除

各連携アプリの設定ページから、接続済みアカウントに対して次の操作が行えます。

- **Switch account（アカウント切り替え）**：別のアカウントへ接続を切り替えます。サインイン型連携ではプロバイダーのアカウント選択画面が開き（Google は常にアカウントを確認します）、新しいサインインが完了するまで現在のアカウント接続が維持されます。認証情報貼り付け型では Credentials セクションへ移動し、新しい値を保存してプロバイダーに受理されると置き換わります。Space 管理者は入力欄で **Use a saved secret** を選ぶこともでき、Hub がその Space シークレットの現在値を画面へ表示せずにコピーして検証します（コピーはシークレット監査ログに記録されます）。
- **Pause（一時停止）**：サインイン情報を保持したまま、コマンド実行とチャンネルへのイベント配信を停止します。**Resume（再開）** で再サインインなしに元に戻せます。
- **Remove（削除）**：確認後、接続・保存済み認証情報・チャンネル購読をすべて削除します。

Google 系アプリは一時停止に対応しておらず、停止時にサインイン情報を削除する設計のため、代わりに **Sign out** が表示されます。複数アカウント対応アプリ（GitHub、Gmail、Stripe、Cloudflare、X）は、アカウント一覧から個別に追加・削除します。

## イベント購読

会話をイベントソースに購読させると、そのイベントが会話に投稿されます。

```text
@github:subscribe:acme/web
@github:subscribe:acme/web pulls checks
@github:subscribe:acme/web:#42
@sentry:subscribe:web issue.created issue.regressed
@linear:subscribe:*
@github:unsubscribe:acme/web checks
```

ターゲットの後ろに単語を並べて購読するイベント種別を選びます。省略時はアプリのデフォルト設定が適用され、`all` を指定すると全種別を購読します。

GitHub の種別は `issues`、`pulls`、`comments`、`reviews`、`commits`、`checks`、`status`、`releases` です。`except:LOGIN` を付けると、特定の GitHub アカウントによる操作（作成した Issue/PR や発生させたイベント）を除外できます。たとえば `@github:subscribe:acme/web issues pulls except:octocat` は他メンバーの Issue と PR のみを投稿し、`@github:unsubscribe:acme/web except:octocat` で除外を解除します。なお、エージェントが開いたプルリクエストはその会話へ自動購読されるため、CI 結果・レビュー・マージ通知が依頼元の会話にそのまま届きます。

イベントをトリガーにエージェントを起動したい場合は、ページ上の[プログラム](programs.md#events-from-connected-apps)で待機させます。

## GitHub

GitHub 連携は `repo:` 起動条件の基盤でもあります。連携することで Space のリポジトリが起動ターゲットになり、エージェントは Space の GitHub 接続を使ってプッシュできるようになります。

| コマンド | 動作 |
| --- | --- |
| `@github:subscribe:OWNER/REPO [kinds]` | リポジトリのイベントをこの会話に投稿 |
| `@github:subscribe:OWNER/REPO:#42` | 特定の Issue またはプルリクエストを購読 |
| `@github:unsubscribe:OWNER/REPO [kinds]` | 購読を停止 |
| `@github:comment:OWNER/REPO:#42 <body>` | Issue またはプルリクエストにコメント |
| `@github:create_issue:OWNER/REPO <title>` | Issue を作成（2 行目以降が本文） |
| `@github:close_issue:OWNER/REPO:#42` | Issue またはプルリクエストをクローズ |
| `@github:reopen_issue:OWNER/REPO:#42` | 再オープン |
| `@github:review:OWNER/REPO:#42 approve <body>` | レビュー投稿（`approve`、`request_changes`、`comment`） |
| `@github:merge:OWNER/REPO:#42 squash` | マージ（`merge`、`squash`、`rebase`） |
| `@github:rerun_failed_jobs:OWNER/REPO:RUN_ID` | 失敗したワークフロージョブを再実行 |
| `@github:dispatch_workflow:OWNER/REPO:WORKFLOW.yml:REF {…}` | 指定 ref でワークフローを実行（任意の JSON 入力可） |

## その他の連携アプリ

各アプリのアクションは **Apps** パネルとコンポーザーに一覧表示されます。現在利用できるアプリは次のとおりです。

| アプリ | ID | イベント | アクション |
| --- | --- | --- | --- |
| GitLab | `gitlab` | マージリクエスト、プッシュ、パイプライン、Issue、コメント、リリース | `read_issue`, `read_merge_request`, `comment`, `merge`, `retry_pipeline` |
| Bitbucket | `bitbucket` | プルリクエスト、コメント、プッシュ、ビルド | `read_pull_request`, `comment` |
| Sentry | `sentry` | 新規 Issue、リグレッション、解決、担当割り当て、無視、アラート、コメント | `read_issue`, `list_issues`, `resolve`, `unresolve`, `ignore` |
| Linear | `linear` | Issue、コメント、プロジェクト | `read_issue`, `comment`, `create_issue` |
| Jira | `jira` | Issue、コメント | `read_issue`, `comment`, `transition` |
| PagerDuty | `pagerduty` | 発報、確認（Ack）、解決、更新 | `read_incident`, `acknowledge`, `resolve`, `note` |
| Opsgenie | `opsgenie` | 作成、確認、クローズ、更新 | |
| Grafana | `grafana` | 発火（Firing）、解決 | |
| Vercel | `vercel` | デプロイ開始・成功・失敗 | `redeploy` |
| Netlify | `netlify` | デプロイ開始・成功・失敗 | |
| Cloudflare | `cloudflare` | アラート発火・解決 | `query_logs`, `list_deployments`, `rollback` |
| Google Cloud | `gcp` | Monitoring インシデント発火・解決 | プロジェクト、Cloud Run、ログ、メトリクス、コスト、API |
| CircleCI | `circleci` | 失敗、成功 | |
| Buildkite | `buildkite` | 失敗、通過 | |
| Stripe | `stripe` | 決済失敗、紛争（Dispute）、サブスクリプション変更（Stripe 連携、または独自 Webhook による全イベント） | |
| Google Docs, Drive & Sheets | `google` | | `read_doc`, `create_doc`, `append_doc`, `read_sheet`, `update_sheet`, `create_sheet`, `list_files` |
| Google Search Console | `googlesearchconsole` | | `query`, `inspect_url`, サイトマップ、プロパティ、所有権確認 |
| Google Calendar | `googlecalendar` | | `list_calendars`, `list_events`, `get_event`, `freebusy`, `create_event`, `update_event`, `delete_event`（書き込みはデフォルトで承認制。[ガイド](https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/connectors/google-calendar.md)） |
| Google Analytics | `googleanalytics` | | `list_properties`, `report` |
| Google Ads | `googleads` | | `list_accounts`, `read_account`, `query`, `validate_mutations`; `mutate`, `set_campaign_status`（デフォルトで承認制） |
| Google Play Console | `googleplay` | | `list_apps`, `tracks`, `release`, `base_plans`, `base_plan`, `one_time_product`, `api_operations`, `api_schema`, `api_read`, `api_plan`, `api_write`, `api_upload` |
| Google Business Profile | `googlebusinessprofile` | | `list_accounts`, `list_locations`, `performance`, `reviews`, `reply_review` |
| Google AdSense | `googleadsense` | | `list_accounts`, `list_sites`, `list_adunits`, `report`, `list_payments`, `list_alerts`, `list_policy_issues` |
| PageSpeed Insights | `pagespeed` | | `audit`, `field` |
| Bing Webmaster Tools | `bingwebmaster` | | `list_sites`, `traffic`, `queries`, `pages`, `crawl_stats`, `submit_urls`, `submit_sitemap`, `indexnow` |
| Yandex Webmaster | `yandexwebmaster` | | `list_hosts`, `summary`, `queries`, `recrawl` |
| Gmail | `gmail` | | `search`, `read`; `send`, `reply`（デフォルトで都度 Space 管理者の承認が必要）。複数メールボックス対応、各ボックスは所有するメンバー／エージェントのみ利用可能 |
| X | `x` | | `accounts`, `read_post`, `timeline`, `media_status`; `post`, `upload_video`, `publish_video`, `quote`（デフォルトで承認制）。明示的なアカウント選択が必要。引用投稿には X Enterprise API アクセスが必要 |
| Notion | `notion` | | `read_page`, `append`, `create_page` |
| Slack | `slack` | メッセージ、リアクション | `post` |
| App Store Connect | `appstoreconnect` | バージョン状態、ビルドアップロード、TestFlight 審査・フィードバック | `list_apps`, `status`, `builds`, `read_version`, `reviews`, `sales`, `review_messages`, `review_attachments`, `review_attachment`, `review_draft`, `edit_review_draft`, `send_review_draft`, `api_operations`, `api_schema`, `api_read`, `api_plan`, `api_write`, `web_session`, `create_app`, `privacy`, `set_privacy`, `read_app`, `create_version`, `set_metadata`, `set_build`, `submit`, `cancel_submission`, `subscriptions`, `submit_subscriptions`, `in_app_purchases`, `submit_in_app_purchases`, `release`, `pause_phased_release`, `resume_phased_release`, `complete_phased_release`, `reply_review`, `set_app_info`, `set_age_rating`, `set_price`, `set_availability`, `set_review_contact`, `upload_build`, `upload_screenshot`, `commit_upload`, `read_upload`, `delete_upload`, `build_uploads`, `screenshot_specs`, `screenshots`, `set_screenshots`, `declare_encryption`, `signing`, `register_bundle_id`, `enable_capability`, `create_certificate`, `read_certificate`, `create_profile`, `read_profile`, `testflight`, `feedback`, `crash_log`, `add_to_group`, `submit_beta_review`, `set_test_notes` |
| Discord | `discord` | | `post` |
| Telegram | `telegram` | メッセージ | `send` |
| Feishu / Lark | `feishu` | メッセージ | `send` |
| Microsoft Teams | `teams` | メッセージ | `post` |
| Google Chat | `googlechat` | メッセージ | `post` |
| DingTalk | `dingtalk` | | `post`, `read`, `send` |
| WeCom | `wecom` | メッセージ | `post`, `send` |
| Webhook | `webhook` | 任意の署名付き JSON 配信 | |
| OpenConnector | `openconnector` | | `search`, `run`：自身の OpenConnector ランタイムのアクション |

実行例：

```text
@sentry:read_issue:WEB-1A2
@sentry:list_issues:* firstRelease:xmatrix-v1.2.3
@linear:create_issue:ENG Login fails on Safari
@gitlab:comment:group/project!5 Looks good.
@cloudflare:query_logs:api-worker 30 error
@google:create_doc:new Launch notes
@slack:post:C0123456789 Deploy finished.
```

## X クレジット

Pro プランでは、有料の X アクションを実行すると（エージェント実行か、人による実行・承認かを問わず）Space のクレジット残高を消費します。

| アクション | クレジット |
| --- | --- |
| プレーンテキスト投稿 | 30 |
| URL・引用・メディア付き投稿 | 400 |
| 投稿またはタイムラインの読み取り | 返却 1 件あたり 10 |
| プロフィール参照（Connect・Check を含む） | 1 プロフィールあたり 20 |
| メディアアップロードまたは状態確認 | 30 |

アカウント一覧取得、承認リクエスト、トークン更新は無料です。X 側で拒否された呼び出しや X 到達前に失敗した呼び出しは返金されます。メディアおよび URL・引用・メディア付き投稿のレートは、X 側の課金確定に伴い変更される場合があります。

## Google Ads の管理

**Apps** から Google Ads を接続し、Credentials で広告主のカスタマー ID を選択して Check を実行します。この Google 連携は Analytics、Search Console、Drive とは独立しています。読み取りも変更も、指定した広告主以外をターゲットにすることはできません。

```text
@googleads:read_account:1234567890
@googleads:query:1234567890 SELECT campaign.id, campaign.name, campaign.status, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_7_DAYS LIMIT 50
@googleads:set_campaign_status:1234567890/987654321 {"status":"PAUSED"}
```

`validate_mutations` は変更を適用せずに妥当性を検証します。`mutate` は予算・キャンペーン・クリエイティブ・ターゲティングをまとめて作成・更新します（新規キャンペーンは必ず一時停止状態で作成されます）。`mutate` とキャンペーン状態変更はいずれもデフォルトで Space 管理者の都度承認が必要です。キャンペーンを有効化するには、通貨コードと想定する現在の 1 日平均予算（整数のマイクロ単位）を明示的に指定します。

```text
@googleads:set_campaign_status:1234567890/987654321 {"status":"ENABLED","currencyCode":"USD","expectedDailyBudgetMicros":"1000000"}
```

100 万マイクロがアカウント通貨の 1 単位に相当します。1 日平均予算は厳密な上限ではなく、Google が特定の日に平均を上回って消化する場合があります。広告の審査と配信は非同期です。結果が不確定な書き込みを再実行する前には必ずクエリで確認してください。完全な設定手順と仕様は [Google Ads コネクタドキュメント](https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/connectors/google-ads.md)を参照してください。

## App Store へのアプリ公開

App Store Connect を連携すると、エージェントがビルドのアップロードからストア公開までを進め、審査結果も会話で報告できます。**Apps** から App Store Connect API キー（Users and Access → Integrations）の Key ID、Issuer ID、`.p8` ファイル内容を登録して接続します。キーには App Manager ロールが必要です。

```text
@appstoreconnect:subscribe:com.example.app
@appstoreconnect:create_version:com.example.app 1.2.0
@appstoreconnect:set_metadata:com.example.app 1.2.0 {"locale":"en-US","whatsNew":"Faster sync and two crash fixes."}
@appstoreconnect:set_build:com.example.app 1.2.0 412
@appstoreconnect:submit:com.example.app 1.2.0
@appstoreconnect:release:com.example.app 1.2.0
```

- `subscribe` は Apple 側にアプリの Webhook を自動登録します。ビルド処理の完了や、バージョン状態の変化（審査待ち、審査中、リジェクト、承認、公開）が会話に届きます。[プログラム](programs.md#events-from-connected-apps)でこれらを待機し、リジェクト時にエージェントへ対応させることもできます。
- `create_version` は手動リリース設定で次のバージョンを作成します。承認後すぐ自動公開したい場合は `release=after_approval` を付けます。App Review の連絡先やサインイン情報は会話に表示せずに前バージョンから引き継がれます。
- `set_build` は Apple での処理完了後にビルド番号を紐づけます。ビルドを作ったエージェントは、手元のマシンに Apple キーを持たずにアップロードできます（下の[ファイルのアップロード](#uploading-files)参照）。
- `submit` はバージョンを App Review へ提出します。ストア情報の不足により Apple に拒否された場合、レシートに不足項目が表示されます。
- `release` はデベロッパーリリース待ちの承認済みバージョンを公開します。`phased` を付けると 7 日間の段階的リリースになり、`pause_phased_release` で一時停止、`resume_phased_release` で再開、`complete_phased_release` で全員へ即時公開します。リリース自体は取り消せません。Space 管理者は App Store Connect の権限を Read only にすることで書き込みを止められます。

`@appstoreconnect:status:com.example.app` で全バージョンの状態を確認でき、`reviews` と `reply_review` でカスタマーレビューに対応できます。別プラットフォームのバージョンは `macos/1.2.0`、`tvos/1.2.0`、`visionos/1.2.0` のように指定します。

新規アプリはレコード作成から始めます。Bundle ID を登録（下の `register_bundle_id`）し、Space 管理者が Credentials に Web セッションを保存していれば、`create_app` で初回バージョン付きのアプリレコードを作成でき、`set_privacy` で App Privacy を回答・公開できます（`privacy` で現在の回答を読み取れます）。Apple の公式 API にはこれらの操作がないため、保存済み Web セッションを使って App Store Connect の Web サイト経由で実行します。

```text
@appstoreconnect:create_app:com.example.app {"name":"Example","sku":"EXAMPLE","locale":"en-US","version":"1.0","platform":"ios"}
@appstoreconnect:set_privacy:com.example.app {"data":[{"category":"EMAIL_ADDRESS","purposes":["APP_FUNCTIONALITY"],"linked":true,"tracking":false}]}
```

`set_privacy` は既存の回答をすべて上書きします。何も収集しない場合は `{"data":[]}` を指定します。年齢制限の回答と同様、これらは Apple に対する公式な申告内容であるため、アプリの実態に即して指定してください。

初回提出前にはいくつか必須項目を埋める必要があります。`@appstoreconnect:read_app:com.example.app` で不足項目を確認でき、その大半はエージェントが設定できます。

```text
@appstoreconnect:set_app_info:com.example.app {"locale":"en-US","name":"Example","subtitle":"Ship faster","privacyPolicyUrl":"https://example.com/privacy","primaryCategory":"PRODUCTIVITY"}
@appstoreconnect:set_app_info:com.example.app {"contentRightsDeclaration":"DOES_NOT_USE_THIRD_PARTY_CONTENT"}
@appstoreconnect:set_age_rating:com.example.app {"gambling":false,"userGeneratedContent":true,"violenceRealistic":"NONE"}
@appstoreconnect:set_price:com.example.app free
@appstoreconnect:set_availability:com.example.app all
@appstoreconnect:set_review_contact:com.example.app 1.0.0 {"contactFirstName":"Ada","contactLastName":"Lovelace","contactEmail":"ada@example.com","contactPhone":"+1 555 0100"}
```

年齢制限のアンケートは自動補完されません。質問項目をすべて指定する必要があり、未回答の項目は `read_app` で `null` として表示されます。

### App Review への返信

`review_messages` は最新の審査スレッド（スレッド ID、メッセージ ID、添付ファイルメタデータを含む）を読み取ります。古いスレッドを読むにはスレッド ID を、長文本文を読むにはメッセージ ID を追加します。保存済み Web セッションがあれば、`review_attachments` で添付一覧を取得し、`review_attachment` で署名付きの一時ダウンロード URL を発行できます（Apple の Cookie や API キーなしで取得可能です）。

`review_draft` で未送信の返信下書きと現在のダイジェストを読み取り、`edit_review_draft` で下書きを作成・更新・削除します。`send_review_draft` はその正確な下書きを送信し、Apple 側の反映メッセージを確認します。返信送信までは下書きのまま保持され、返信を送ってもアプリ自体は再提出されません。送信結果が不確かな場合は再試行前にスレッドを確認してください。引数や制限の詳細は[審査ワークフロー](https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/connectors/app-store-connect-review.md)を参照してください。

### ファイルのアップロード

ビルドやスクリーンショットは 3 ステップで Apple へ直接送信され、ファイル本体が xMatrix を通過することはありません。

```text
@appstoreconnect:upload_build:com.example.app 1.2.0 412 Example.ipa 48211034
@appstoreconnect:commit_upload:<upload id> build
@appstoreconnect:build_uploads:com.example.app 412
```

1. `upload_build` でアップロード枠を予約します。ファイル内のバージョン番号・ビルド番号・ファイル名・正確なバイトサイズを指定すると、レシートに 1 つ以上のパート情報（メソッド、URL、バイト範囲、ヘッダー）が返ります。
2. ファイルを持つマシン上のエージェントが、各パートのバイト列を指定ヘッダー付きで直接 URL へ送信します。URL は Apple が発行する期限付きのもので、そのファイル専用です。
3. `commit_upload` でアップロード完了を Apple へ通知します。その後 Apple がビルドを処理し、購読中の会話に完了通知が届きます。エラーがあれば `build_uploads` で確認できます。

スクリーンショットも同様にアップロードし、ストア掲載情報へ配置します。

```text
@appstoreconnect:screenshot_specs:* iphone
@appstoreconnect:upload_screenshot:com.example.app home-6.9.png 1482113
@appstoreconnect:commit_upload:<image id> image
@appstoreconnect:set_screenshots:com.example.app 1.2.0 {"locale":"en-US","group":"<group>","images":["<image id>","<image id>"]}
```

`screenshot_specs` はデバイスファミリーごとの配置グループと許容ピクセルサイズを一覧表示します。`set_screenshots` は対象言語とグループの画像を、指定した画像・順序に厳密に揃えます（同じ画像を複数言語で再利用できます）。現在の登録状態は `screenshots` で確認できます。

輸出コンプライアンスの申告が必要な場合は、`@appstoreconnect:declare_encryption:com.example.app 1.2.0 412 exempt` でビルド単位に回答できます。

### Apple ID のないマシンでのコード署名設定

新しい Mac や CI ランナー上のエージェントでも、コネクタ経由で App Store 署名をセットアップできます。秘密鍵はそのマシン上で生成されて外へ出ず、署名要求（CSR）だけが送信されます。

```text
@appstoreconnect:signing:com.example.app
@appstoreconnect:register_bundle_id:com.example.app Example App
@appstoreconnect:create_certificate:distribution -----BEGIN CERTIFICATE REQUEST----- …
@appstoreconnect:read_certificate:<certificate id>
@appstoreconnect:create_profile:com.example.app <certificate id>
@appstoreconnect:read_profile:<profile id>
```

`signing` で既存の証明書・プロファイルを確認できます。チームごとに作成できる配布用証明書には上限があるため、既存の秘密鍵を持つマシンが残っていない場合のみ新規作成してください。`enable_capability` で `PUSH_NOTIFICATIONS` などの機能を Bundle ID に有効化でき、プロファイルはその後に作成します。

### TestFlight

```text
@appstoreconnect:testflight:com.example.app
@appstoreconnect:add_to_group:com.example.app 1.2.0 412 Early Access
@appstoreconnect:set_test_notes:com.example.app 1.2.0 412 en-US Try the new sync.
@appstoreconnect:submit_beta_review:com.example.app 1.2.0 412
@appstoreconnect:feedback:com.example.app
@appstoreconnect:crash_log:<feedback id>
```

購読種別に `feedback` を含めておくと、テスターからの報告をエージェントが拾えます。`feedback` で端末・OS・ビルド情報付きのコメント一覧を取得でき、`feedback:… crashes` と `crash_log` でクラッシュログを確認できます。

### App Review でリジェクトされたとき

リジェクト通知は会話に届きます。`@appstoreconnect:review_messages:com.example.app` で、保存済み Web セッションを使ってリジェクト理由と審査官のメッセージを取得できます。xMatrix アプリの「Sign in to App Store Connect」から Apple の公式サインイン画面を開いてセッションを保存できます。`review_attachments` で添付一覧を取得し、`review_attachment` で認証不要の期限付きダウンロード URL を取得できます。`review_draft` で確認し、`edit_review_draft` で返信下書きを作成したうえ、`send_review_draft` に正確な ID とダイジェストを渡して送信します。返信送信だけでは再提出されません。問題修正後に `submit` で同じ提出物を再審査へ送るか、`cancel_submission` 後に `submit` で新規提出します。

アプリの初回サブスクリプションはアプリバージョンと一緒に審査されます。`subscriptions` で審査状態を確認し、`submit_subscriptions` で準備完了のもの（または指定した Product ID）を下書き提出へ追加すると、次の `submit` でアプリと一緒に審査へ送られます。買い切り型アプリ内課金（クレジットパックなどの消耗型、非消耗型、非更新サブスクリプション）は別枠で、`in_app_purchases` で一覧を確認し、`submit_in_app_purchases` で提出へ追加したのち、次の `submit` で一括提出します。

サインイン、契約同意、銀行・税務情報、審査用アカウントの非公開認証情報は引き続きアカウント所有者が管理します。保存済み Web セッションはアプリレコード作成、App Privacy 設定、審査返信をサポートします。

### その他の App Store Connect リソース

`api_operations:* <resource>` で固定バージョンの公式 API 操作を検索し、`api_schema:<operation or schema>` で正確なパラメータ仕様を確認できます。`api_read` はサブスクリプション／IAP 設定、TestFlight テスター・グループ、価格・オファー、通知、アセット、デバイス、チーム権限、レポートなど幅広いリソースをカバーします。個人情報や財務データを含む場合はプライベート読み取りを使用してください。書き込み系では、まず `api_plan` が Apple へ変更を加えずにリクエストを検証してダイジェストを返し、`api_write` がそのダイジェストと現在の対象状態を照合したうえで実行します。いずれのアクションもログインシークレットは受け付けません。結果が不確かな書き込み（特に新規リソース作成）は再試行前に必ず状態を確認してください。

## エージェントと連携アプリ

エージェントも人間が入力する場合とまったく同じコマンド・ルールで、会話上の可視メッセージを通じて連携アプリを操作します。`xmatrix connector list` で接続済みアプリとコマンドを確認でき、`xmatrix send <channel-id> "<command>"` で実行します。結果は元のメッセージへの返信として届きます。エージェント側への個別設定は不要です。

Gmail の検索・閲覧はメール本文を会話のレシートに投稿し、実行履歴にも一定長の抜粋が保存されます。その会話を閲覧できる全員が内容を読める点に注意してください。検索は `@gmail:search:* is:unread newer_than:1h` のように実行するか、`*` を特定の接続済みメールアドレスに置き換えます。コネクタ用 MCP や呼び出し元限定のメール取得機能はありません。

メッセージに出してはいけないログインコードや認証情報の取得に、これらのアクションを使わないでください。Gmail から Space シークレットへ直接転送する機能もありません。認可された手動ログインが必要な場合、エージェントは `xmatrix request secret-add <fresh-alias> --env QA_LOGIN_CODE --reason "QA login"` をリクエストし、Space 管理者がチャットではなくリクエストカードにコードを入力します。その後エージェントは `xmatrix secret exec --secret <fresh-alias>=QA_LOGIN_CODE -- <login-command>` を使い、値を出力・スクリーンショット・トレース・リクエストログに残さないプロセスへ注入します。この手動シークレット入力はメール配信や自動ログインの検証にはなりません。会話レシートに出力された後で値をシークレット保存しても、既に出力された履歴は消えません。

## アクションの制限と承認

Gmail の送信・返信はデフォルトで **Ask**（事前承認）になっています。リクエストごとに送信元・宛先・件名・本文が会話の **Pending approvals** に表示され、Space 管理者が **Allow once**（1 回許可）または **Disallow**（拒否）を選びます。1 通を承認しても次のメールには引き継がれず、承認待ちの間は何も送信されません。

Apps → Gmail → Permissions から、**Read only**（読み取り専用）、**Ask first**（都度承認）、**Read and write**（読み書き許可）を選択できます。この設定は全会話におけるその接続全体に一括適用されます。読み取りは 3 モードすべてで利用でき、Ask first は変更ごとに承認を挟み、Read and write は変更を直接実行します。チャンネル単位やアクション単位の個別ルールはありません。デフォルトでは Calendar が Read and write、Gmail・Google Ads・X・Linear が Ask first です。GitHub は Read only または Read and write に対応しています。
