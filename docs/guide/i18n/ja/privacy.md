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

**要約:** 登録した AI ツールの残りクォータを表示するため、xMatrix daemon はお使いのコンピュータ上にあるそれらのツール自身のログインファイル（例: `~/.codex/auth.json`）を読み取り、各プロバイダに直接問い合わせます。これらのファイルから読み取った内容（トークン、アカウント ID、ファイル内容、ファイルのフィンガープリント）は一切 xMatrix に送信されず、Hub が受け取るのは正規化されたクォータ情報のみです。1 つのスイッチでファイルの読み取りとプロバイダへのリクエストの両方を停止できます（下記「ローカルクォータ照会を無効にする」を参照）。

登録済みのハーネス（Claude Code、Codex、Cursor、Grok、OpenCode、DeepSeek、Z.ai、Antigravity 等）について、`xmatrix agent list` や Agents 画面で残量を表示し、`@auto` ルーティングで上限到達アカウントを避けるために、ローカルデーモンが登録済みツールのローカル認証ストアを読み取り各プロバイダの残量 API を直接照会する場合があります。

| ハーネス | ローカルメモリのみで読む保存先 | マシンから直接問い合わせるプロバイダ API |
| --- | --- | --- |
| Claude Code | macOS キーチェーン（`Claude Code-credentials`）または `~/.claude/.credentials.json` | `https://api.anthropic.com/api/oauth/usage` |
| Codex | `$CODEX_HOME/auth.json` または `~/.codex/auth.json` | `https://chatgpt.com/backend-api/wham/usage` |
| Cursor | `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`、macOS キーチェーン（`cursor-access-token`）、または Cursor `auth.json` | `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| Grok Build | `GROK_CLI_OAUTH_TOKEN` または `~/.grok/auth.json` | `https://cli-chat-proxy.grok.com/v1/billing?format=credits` |
| OpenCode | `OPENCODE_API_KEY` または OpenCode `auth.json` | `https://opencode.ai/zen/go/v1/usage` または ChatGPT `wham/usage` |
| DeepSeek | `DEEPSEEK_API_KEY` または `$DSH_HOME` 認証ファイル | `https://api.deepseek.com/user/balance` |
| Z.ai / Zhipu | `ZAI_API_KEY` / `ZHIPU_API_KEY` | `https://api.z.ai/api/monitor/usage/quota/limit`（または `open.bigmodel.cn`） |
| Antigravity | 未改変の `agy -p "/usage" --output-format json` を実行 | `agy` 自身が処理 |

**厳格な境界:**

- 認証情報はローカルプロセスのメモリ内にとどまり、**該当プロバイダ自身の利用状況エンドポイントのみ**に送信されます。
- ローカルの SHA-256 フィンガープリントはアカウント切替検知用のメモリ内キャッシュキーとしてのみ使われ、**ログ出力や xMatrix への送信は一切行いません**。
- xMatrix Hub に送られるのは正規化された残量情報（割合、リセット時刻、利用可否、残高）のみです。

### ローカルクォータ照会を無効にする

デスクトップアプリの **Settings → Legal and privacy → Local provider quota probes**、または以下のコマンド／環境変数で無効にできます：

```sh
xmatrix config quotaProbes off
# または環境変数（優先）
export XMATRIX_DISABLE_QUOTA_PROBES=1
```

Antigravity のみ無効にする場合は `XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE=1` を設定してください。無効化するとすべての経路でローカル認証ストアの読み取りと残量照会を行いません。

## クライアント診断とクラッシュレポート

xMatrix は広告 Cookie、クロスサイト追跡、セッションリプレイ、PostHog・Google Analytics・Cloudflare Web Analytics 等のサードパーティ行動分析 SDK を使用していません。

任意のクライアント診断とブラウザのクラッシュレポートは、**安定版のアプリと CLI ではデフォルトでオフ**です。ベータ版のデフォルトは下の表のとおりです。未ログインのマーケティング、ドキュメント、法的文書のページは Sentry を読み込みません。診断がオンのときに送信されるもの：

- **エラーとクラッシュレポート（Sentry）**：ログイン後のアプリ内でのみ有効。`userInfo`、Cookie、HTTP ヘッダー/本文、URL クエリパラメータ、コンソールのブレッドクラムは無効化され、引用テキストはマスクされます。DSN のないローカル/セルフホストのビルドは何も送信しません。（Hub サーバー側のエラーは、ホスト型サービス運用のため引き続きサーバー側で報告されます。）
- **ファーストパーティ診断（xMatrix Hub → Cloudflare Analytics Engine）**：起動時間（`/api/observable/startup-timing`）、オンボーディングのステップ数（`/api/observable/onboarding-step`）、デスクトップ daemon の起動失敗（`/api/observable/desktop-daemon-failure`）、CLI の再接続サンプル（`/api/observable/client-metrics`）。識別子はサーバー側で鍵付き HMAC-SHA-256 により仮名化され、メッセージやコマンドの本文は含まれません。

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
- **デスクトップの起動失敗カード**：診断がオフでも、daemon の起動失敗カードで **Send failure report** を一度選べば、マスク済みの失敗情報を送れます。
- **CLI と daemon**：`xmatrix config telemetry on` または `XMATRIX_TELEMETRY=1` でオン、`xmatrix config telemetry off`、`XMATRIX_TELEMETRY=0`、`DO_NOT_TRACK=1` でオフ。`xmatrix config telemetry on|off` は選択をアカウントにも保存します。

## 法的文書

- [プライバシーポリシー (EN)](/privacy)
- [Cookie・ローカルストレージ通知 (EN)](/cookies)
- [復委託先一覧 (EN)](/subprocessors)
- [利用規約 (EN)](/terms)
