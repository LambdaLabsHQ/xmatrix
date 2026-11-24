---
title: "テレメトリ・診断・ローカルプライバシー — xMatrix ドキュメント"
description: "ローカルに残るデータ、オプションのクォータ照会やクライアント診断の仕組み、および無効化手順。"
---

# テレメトリとローカルプライバシー

xMatrix はホスト型コラボレーション Hub と、ご自身のマシン上で動く Rust ローカルデーモンで構成されています。このページではクライアントとデーモンが行うすべての診断送信・ローカル読み取りと、それらの無効化方法を明記します。

## マシン上に残るデータ

ソースコード、Git 履歴、作業ディレクトリ、プロバイダの会話履歴、およびローカルのモデル認証情報はご自身のマシン上に残ります。xMatrix が API キーや OAuth トークンを Hub へ送信したり、他ツールの認証情報から複数マシンを横断するユーザー追跡を行ったりすることはありません。

## ローカルのプロバイダクォータ照会

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

```sh
xmatrix config quotaProbes off
# または環境変数（優先）
export XMATRIX_DISABLE_QUOTA_PROBES=1
```

Antigravity のみ無効にする場合は `XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE=1` を設定してください。無効化するとローカル認証ストアの読み取りと残量照会を一切行いません。

## クライアント診断とクラッシュレポート

xMatrix は広告 Cookie、クロスサイト追跡、セッションリプレイ、PostHog・Google Analytics・Cloudflare Web Analytics 等のサードパーティ行動分析 SDK を使用していません。

デフォルトではログイン済みクライアントから障害修正・性能改善用の限定的な診断情報を送信します：

- **エラー・クラッシュレポート（Sentry）**：ユーザー情報・Cookie・HTTP ヘッダー/ボディ・URL クエリ・コンソールログを無効化し、引用文字列をマスクして送信します。DSN のないローカル／セルフホストビルドでは送信しません。
- **ファーストパーティ診断（xMatrix Hub → Cloudflare Analytics Engine）**：起動時間（`/api/observable/startup-timing`）、初期設定ステップ数（`/api/observable/onboarding-step`）、デスクトップデーモン起動失敗情報（`/api/observable/desktop-daemon-failure`）、CLI 再接続サンプル（`/api/observable/client-metrics`）。識別子はサーバー側の鍵付き HMAC-SHA-256 で仮名化され、メッセージ本文やコマンド内容は含みません。

### 診断とクラッシュレポートを無効にする

- **Web・Desktop・iOS・Android**：**Settings → Legal and privacy** で **Send diagnostics and crash reports** をオフにします。
- **ブラウザのプライバシー信号**：設定で明示的に有効化しない限り、**Do Not Track（DNT）** と **Global Privacy Control（GPC）** を自動的に尊重します。
- **CLI とデーモン**：`xmatrix config telemetry off` を実行するか、`XMATRIX_TELEMETRY=0` または `DO_NOT_TRACK=1` を設定してください。

## 法的文書

- [プライバシーポリシー (EN)](/privacy)
- [Cookie・ローカルストレージ通知 (EN)](/cookies)
- [復委託先一覧 (EN)](/subprocessors)
- [利用規約 (EN)](/terms)
