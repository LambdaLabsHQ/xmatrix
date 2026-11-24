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

**要約:** 登録した AI ツールの残りクォータを表示するため、xMatrix daemon はお使いのコンピュータ上にあるそれらのツール自身のログインファイル（例: `~/.grok/auth.json`）を読み取り、各プロバイダに直接問い合わせます。Codex、Claude Code、OpenCode は例外で、xMatrix はツール自身に問い合わせ、それらのログインファイルは開きません。Codex には実行中のセッションまたは一時的に起動した `codex app-server` を通じて、Claude Code には実行中のセッションまたは一時的に起動した `claude` を通じて（プロンプトを送らない `get_usage` リクエスト）、OpenCode には一時的に起動した `opencode serve` を通じて問い合わせます。これらのファイルから読み取った内容（トークン、アカウント ID、ファイル内容、ファイルのフィンガープリント）は一切 xMatrix に送信されず、Hub が受け取るのは正規化されたクォータ情報のみです。1 つのスイッチでファイルの読み取り、Codex・Claude Code・OpenCode へのリクエスト、プロバイダへのリクエストをすべて停止できます（下記「ローカルクォータ照会を無効にする」を参照）。

登録済みのハーネス（Claude Code、Codex、Cursor、Grok、OpenCode、DeepSeek、Z.ai、Antigravity 等）について、`xmatrix agent list` や Agents 画面で残量を表示し、`@auto` ルーティングで上限到達アカウントを避けるために、ローカルデーモンが登録済みツールのローカル認証ストアを読み取り各プロバイダの残量 API を直接照会する場合があります。

| ハーネス | ローカルメモリのみで読む保存先 | マシンから直接問い合わせるプロバイダ API |
| --- | --- | --- |
| Claude Code | 読み取りなし: Claude Code 自身の `get_usage` 制御リクエスト（実行中のセッションまたは一時的に起動した `claude`）。プロンプトは送信しません | Claude Code が自身のサインインで処理 |
| Codex | 読み取りなし: Codex 自身の app-server メソッド `account/rateLimits/read`（実行中のセッションまたは一時的に起動した `codex app-server`） | Codex が自身のサインインで処理 |
| Cursor | `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`、macOS キーチェーン（`cursor-access-token`）、または Cursor `auth.json` | `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| Grok Build | `GROK_CLI_OAUTH_TOKEN` または `~/.grok/auth.json` | `https://cli-chat-proxy.grok.com/v1/billing?format=credits` |
| OpenCode | 読み取りなし: 一時的に起動した `opencode serve` の `GET /api/experimental/usage/limits`（ループバックのみで待ち受け、一回限りのパスワードを使用）。OpenCode が他のプロバイダにルーティングするモデルでは何も読み取りません | OpenCode が自身のサインインで処理 |
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

Antigravity のみ無効にする場合は `XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE=1` を設定してください。無効化するとすべての経路でローカル認証ストアの読み取り、`codex app-server`・`claude`・`opencode serve` の起動、Codex や Claude Code のセッションへの問い合わせ、残量照会を行いません。

## クライアント診断とクラッシュレポート

xMatrix は広告 Cookie、クロスサイト追跡、セッションリプレイ、PostHog・Google Analytics・Cloudflare Web Analytics 等のサードパーティ行動分析 SDK を使用していません。

**すべての地域で、任意のクライアント診断およびブラウザのクラッシュレポートはデフォルトでオフ（明示的なオプトイン）です。** 未ログインのマーケティング／ドキュメント／法的ページでは Sentry を読み込みません。明示的に有効化した場合（またはデスクトップ起動失敗カードで手動送信を選んだ場合）にのみ送信されます：

- **エラー・クラッシュレポート（Sentry）**：ログイン済みアプリでオプトインした場合のみ、エラーのクラス、エラー自身のコード（ある場合）、スタックのコード位置だけを送信します。エラーメッセージ、パンくず、URL、Cookie、HTTP ヘッダー、リクエストボディ、ユーザー情報は送信しません。DSN のないローカル／セルフホストビルドでは送信しません。（Hub サーバー側のエラーはホスティングサービス運用のためサーバー側で報告されます。下記参照。）
- **ファーストパーティ診断（xMatrix Hub → Cloudflare Analytics Engine）**：オプトイン時のみ起動時間（`/api/observable/startup-timing`）、初期設定ステップ数（`/api/observable/onboarding-step`）、デスクトップデーモン起動失敗情報（`/api/observable/desktop-daemon-failure`）、CLI 再接続サンプル（`/api/observable/client-metrics`）を送信します。識別子はサーバー側の鍵付き HMAC-SHA-256 で仮名化されます。

### 診断イベントに含められるもの

すべての診断イベントには宣言済みのフィールドがあり、クライアントが作成するときと Hub が受け取るときの 2 回検査されます。フィールドに入れられるのは、リスト内の固定値、数値、true/false、バージョン、不透明な識別子、または `websocket_connect_failed` のような短いコード（小文字、数字、`_`、`-`）だけです。宣言されていないフィールドや範囲外の値が 1 つでもあればイベント全体が拒否され、切り詰めて通すことはしません。そのため、あなたが書いた文章を運ぶフィールドはありません。エラーはクラスとコードで報告し、メッセージは含めません。

文章を運ぶのは次の 2 つの経路だけです：

- **デスクトップ起動失敗カードの「失敗レポートを送信」**：CLI の最後の数行。デスクトップアプリがあなたのマシン上で先にマスクします（ホームディレクトリ、メールアドレス、URL クエリ、トークンや鍵のように見える文字列を置換）。カードは送信前にその内容を表示し、ボタンを押したときだけ送信します。診断がオンのときの自動レポートには、失敗した段階、終了コード、プラットフォーム、アプリのバージョンだけが含まれます。
- **Hub サーバー側のエラーレポート**：サーバー自身のエラーメッセージ。引用された値、メールアドレス、URL クエリ、ホームディレクトリのパス、トークン状の文字列は取り除かれます。ログに添えられた項目は、数値、true/false、不透明な識別子の場合だけ報告されます。

### 診断とクラッシュレポートの有効化・無効化

- **Web・Desktop・iOS・Android**：**Settings → Legal and privacy** で **Send diagnostics and crash reports** を切り替えます（デフォルトはオフ）。デスクトップではローカルデーモンの `telemetry` 設定にも連動します。
- **CLI とデーモン**：デフォルトはオフです。有効にするには `xmatrix config telemetry on` または `XMATRIX_TELEMETRY=1`、無効にするには `xmatrix config telemetry off`、`XMATRIX_TELEMETRY=0`、または `DO_NOT_TRACK=1` を設定してください。

## 法的文書

- [プライバシーポリシー (EN)](/privacy)
- [Cookie・ローカルストレージ通知 (EN)](/cookies)
- [復委託先一覧 (EN)](/subprocessors)
- [利用規約 (EN)](/terms)
