---
title: "テレメトリ・診断・ローカルプライバシー — xMatrix ドキュメント"
description: "ローカルに残るデータ、オプションのクォータ照会やクライアント診断の仕組み、および無効化手順。"
---

# テレメトリとローカルプライバシー

xMatrix はホスト型コラボレーション Hub と、ご自身のマシン上で動く Rust ローカルデーモンで構成されています。このページではクライアントとデーモンが行うすべての診断送信・ローカル読み取りと、それらの無効化方法を明記します。

## マシン上に残るデータ

ソースコード、Git 履歴、作業ディレクトリ、プロバイダの会話履歴、およびローカルのモデル認証情報はご自身のマシン上に残ります。xMatrix が API キーや OAuth トークンを Hub へ送信したり、他ツールの認証情報から複数マシンを横断するユーザー追跡を行ったりすることはありません。

再インストール後も同じマシンをアカウント内で安定して識別できるよう、デーモンはローカルで xMatrix ユーザー ID と OS マシン識別子をハッシュ化してアカウント単位の `machineId` を生成します。生のハードウェア識別子やアカウント非分離のフィンガープリントが Hub に送信されることはありません。

## ローカルのプロバイダクォータ照会

**要約:** 登録した AI ツールの残りクォータを表示するため、xMatrix daemon はお使いのコンピュータ上にあるそれらのツール自身のログインファイル（例: `~/.grok/auth.json`）を読み取り、各プロバイダに直接問い合わせます。Codex は例外で、xMatrix は実行中の Codex セッションまたは一時的に起動した `codex app-server` を通じて Codex 自身に問い合わせ、Codex のログインファイルは開きません。これらのファイルから読み取った内容（トークン、アカウント ID、ファイル内容、ファイルのフィンガープリント）は一切 xMatrix に送信されず、Hub が受け取るのは正規化されたクォータ情報のみです。1 つのスイッチでファイルの読み取り、Codex app-server へのリクエスト、プロバイダへのリクエストをすべて停止できます（下記「ローカルクォータ照会を無効にする」を参照）。公式のクォータ照会手段がないツール（Cursor など）は、そのコンピュータで許可するまで一切読み取られません（下記「許可した場合にだけ読み取るツール」を参照）。

登録済みのハーネス（Claude Code、Codex、Cursor、Grok、OpenCode、DeepSeek、Z.ai、Antigravity 等）について、`xmatrix agent list` や Agents 画面で残量を表示し、`@auto` ルーティングで上限到達アカウントを避けるために、ローカルデーモンが登録済みツールのローカル認証ストアを読み取り各プロバイダの残量 API を直接照会する場合があります。

| ハーネス | ローカルメモリのみで読む保存先 | マシンから直接問い合わせるプロバイダ API |
| --- | --- | --- |
| Claude Code | macOS キーチェーン（`Claude Code-credentials`）または `~/.claude/.credentials.json` | `https://api.anthropic.com/api/oauth/usage` |
| Codex | 読み取りなし: Codex 自身の app-server メソッド `account/rateLimits/read`（実行中のセッションまたは一時的に起動した `codex app-server`） | Codex が自身のサインインで処理 |
| Cursor（そのコンピュータで許可した場合のみ） | `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`、macOS キーチェーン（`cursor-access-token`）、または Cursor `auth.json` | `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| Grok Build | `GROK_CLI_OAUTH_TOKEN` または `~/.grok/auth.json` | `https://cli-chat-proxy.grok.com/v1/billing?format=credits` |
| OpenCode | `OPENCODE_API_KEY` または OpenCode `auth.json` | `https://opencode.ai/zen/go/v1/usage` または ChatGPT `wham/usage` |
| DeepSeek | `DEEPSEEK_API_KEY` または `$DSH_HOME` 認証ファイル | `https://api.deepseek.com/user/balance` |
| Z.ai / Zhipu | `ZAI_API_KEY` / `ZHIPU_API_KEY` | `https://api.z.ai/api/monitor/usage/quota/limit`（または `open.bigmodel.cn`） |
| Antigravity | 未改変の `agy -p "/usage" --output-format json` を実行 | `agy` 自身が処理 |

**厳格な境界:**

- 認証情報はローカルプロセスのメモリ内にとどまり、**該当プロバイダ自身の利用状況エンドポイントのみ**に送信されます。
- ローカルの SHA-256 フィンガープリントはアカウント切替検知用のメモリ内キャッシュキーとしてのみ使われ、**ログ出力や xMatrix への送信は一切行いません**。
- xMatrix Hub に送られるのは正規化された残量情報（割合、リセット時刻、利用可否、残高）のみです。

### 許可した場合にだけ読み取るツール

Cursor にはクォータを問い合わせる公式の手段がなく、唯一の方法は Cursor が自分用に保存したサインイン情報を読むことです。このサインイン情報は Cursor のためのものなので、xMatrix はそれを許可とはみなしません。コンピュータの所有者が許可するまで、xMatrix はそのコンピュータ上の Cursor のサインイン情報（macOS キーチェーン項目 `cursor-access-token`、Cursor の `auth.json`、環境に設定済みの `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`）を一切読み取らず、Cursor のクォータは**不明**と表示されます。使い切ったことは引き続き Cursor 自身のエラーメッセージから認識します。

許可するには、コンピュータの所有者が Agents または Machines ビューで Cursor のクォータが表示される場所の **Allow reading Cursor sign-in to show quota** を選ぶか、そのコンピュータで次を実行します。

```sh
xmatrix config quotaAccess cursor on    # 許可
xmatrix config quotaAccess cursor off   # 停止
xmatrix config quotaAccess              # このコンピュータで許可済みのツールを表示
```

- 許可はコンピュータごと・ツールごとで、既定ではオフです。クォータ照会スイッチとは別物で、`quotaProbes` がオンでも許可にはなりません。
- サインイン情報はそのコンピュータ上でのみ、Cursor に自身の使用量を問い合わせるためだけに読み取られます。その内容がコンピュータの外に出ることはなく、Hub が受け取るのは Cursor が返す使用量と、許可の有無だけです。
- 許可は最初に使われたときにサインインしている Cursor アカウントに結び付けられます。その指紋はそのコンピュータの xMatrix 設定にのみ保存され、送信されません。アカウントや認証情報が変わると許可は失効し、直近のクォータの数値も削除されます。
- 同じ場所、**Settings → Legal and privacy → Reading sign-ins for quota**、または `xmatrix config quotaAccess cursor off` でいつでも停止でき、次の読み取りから拒否されます。
- ローカルクォータ照会を無効にする（下記）と許可より優先され、許可していても何も読み取られません。

### ローカルクォータ照会を無効にする

デスクトップアプリの **Settings → Legal and privacy → Local provider quota probes**、または以下のコマンド／環境変数で無効にできます：

```sh
xmatrix config quotaProbes off
# または環境変数（優先）
export XMATRIX_DISABLE_QUOTA_PROBES=1
```

Antigravity のみ無効にする場合は `XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE=1` を設定してください。無効化するとすべての経路でローカル認証ストアの読み取り、`codex app-server` の起動や Codex セッションへの問い合わせ、残量照会を行いません。

## クライアント診断とクラッシュレポート

xMatrix は広告 Cookie、クロスサイト追跡、セッションリプレイ、PostHog・Google Analytics・Cloudflare Web Analytics 等のサードパーティ行動分析 SDK を使用していません。

任意のクライアント診断とブラウザのクラッシュレポートは、**安定版のアプリと CLI ではデフォルトでオフ**です。ベータ版のデフォルトは下の表のとおりです。未ログインのマーケティング、ドキュメント、法的文書のページは Sentry を読み込みません。診断がオンのときに送信されるもの：

- **エラー・クラッシュレポート（Sentry）**：ログイン済みアプリ内でのみ、エラーのクラス、エラー自身のコード（ある場合）、スタックのコード位置だけを送信します。エラーメッセージ、パンくず、URL、Cookie、HTTP ヘッダー、リクエストボディ、ユーザー情報は送信しません。DSN のないローカル／セルフホストビルドでは送信しません。（Hub サーバー側のエラーはホスティングサービス運用のためサーバー側で報告されます。下記参照。）
- **ファーストパーティ診断（xMatrix Hub → Cloudflare Analytics Engine）**：起動時間（`/api/observable/startup-timing`）、初期設定ステップ数（`/api/observable/onboarding-step`）、デスクトップデーモン起動失敗情報（`/api/observable/desktop-daemon-failure`）、CLI 再接続サンプル（`/api/observable/client-metrics`）を送信します。識別子はサーバー側の鍵付き HMAC-SHA-256 で仮名化されます。

### 診断イベントに含められるもの

すべての診断イベントには宣言済みのフィールドがあり、クライアントが作成するときと Hub が受け取るときの 2 回検査されます。フィールドに入れられるのは、リスト内の固定値、数値、true/false、バージョン、不透明な識別子、または `websocket_connect_failed` のような短いコード（小文字、数字、`_`、`-`）だけです。宣言されていないフィールドや範囲外の値が 1 つでもあればイベント全体が拒否され、切り詰めて通すことはしません。そのため、あなたが書いた文章を運ぶフィールドはありません。エラーはクラスとコードで報告し、メッセージは含めません。

文章を運ぶのは次の 2 つの経路だけです：

- **デスクトップ起動失敗カードの「失敗レポートを送信」**：CLI の最後の数行。デスクトップアプリがあなたのマシン上で先にマスクします（ホームディレクトリ、メールアドレス、URL クエリ、トークンや鍵のように見える文字列を置換）。カードは送信前にその内容を表示し、ボタンを押したときだけ送信します。診断がオンのときの自動レポートには、失敗した段階、終了コード、プラットフォーム、アプリのバージョンだけが含まれます。
- **Hub サーバー側のエラーレポート**：サーバー自身のエラーメッセージ。引用された値、メールアドレス、URL クエリ、ホームディレクトリのパス、トークン状の文字列は取り除かれます。ログに添えられた項目は、数値、true/false、不透明な識別子の場合だけ報告されます。

### ベータ版と安定版のデフォルト

| | 安定版アプリと CLI | ベータ版アプリと CLI |
| --- | --- | --- |
| 自分でオンにした | 送信 | 送信 |
| 自分でオフにした、または Do Not Track、Global Privacy Control、`XMATRIX_TELEMETRY=0` | 送信しない | 送信しない |
| 選択なし。登録時の国**と**現在の国がどちらも EU、EEA、英国、スイスの外 | 送信しない | 送信（オフにするリンク付きの 1 行の通知を表示） |
| 選択なし。どちらかの国が EU、EEA、英国、スイス、または不明 | 送信しない | 送信しない。チェックの入っていない「Send diagnostics to help improve the beta」を表示 |

行は上から順に適用されます。明示的にオンにした場合は、Do Not Track や Global Privacy Control が有効でも尊重されます。そのチェックボックスにチェックを入れるか、設定のスイッチを切り替える（または `xmatrix config telemetry on|off`）ことだけが選択として扱われます。通知を閉じても選択にはならず、xMatrix が設定を勝手に変えることはありません。

**地域の判定方法。** クライアントには信頼できる位置情報がない（タイムゾーンと言語はユーザー設定）ため、Hub が伝えます：

- **登録時の地域。** アカウント作成時、Hub は Cloudflare が報告するそのリクエストの国から、事前同意が必要な国かどうかだけを記録します。国や IP アドレスは保存せず、後のリクエストで書き換えることもありません。既存のアカウントは、初めてベータ版を使ったときに記録されます。アカウント削除時に一緒に削除されます。
- **現在の地域。** 送信のたびに、クライアントは現在の接続について Hub が返した 10 分以内の答えを使います。古い場合は、診断データを含まない小さなリクエストで Hub に問い合わせ直します。問い合わせが失敗・タイムアウトした場合や国が不明な場合は送信しません。そのため、同意が必要な国に移動すると、デフォルトの送信は 10 分以内に止まります。

### 診断とクラッシュレポートの有効化・無効化

- **Web、デスクトップ、iOS、Android**：**Settings → Legal and privacy** で **Send diagnostics and crash reports** を切り替えます。選択はアカウントに保存され、すべてのクライアントが従います。デスクトップでは、このスイッチがローカル daemon の `telemetry` 設定も更新します。
- **CLI とデーモン**：デフォルトはオフです。有効にするには `xmatrix config telemetry on` または `XMATRIX_TELEMETRY=1`、無効にするには `xmatrix config telemetry off`、`XMATRIX_TELEMETRY=0`、または `DO_NOT_TRACK=1` を設定してください。
- **CLI と daemon**：`xmatrix config telemetry on` または `XMATRIX_TELEMETRY=1` でオン、`xmatrix config telemetry off`、`XMATRIX_TELEMETRY=0`、`DO_NOT_TRACK=1` でオフ。`xmatrix config telemetry on|off` は選択をアカウントにも保存します。

## 法的文書

- [プライバシーポリシー (EN)](/privacy)
- [Cookie・ローカルストレージ通知 (EN)](/cookies)
- [復委託先一覧 (EN)](/subprocessors)
- [利用規約 (EN)](/terms)
