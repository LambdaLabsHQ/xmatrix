---
title: "テレメトリ・診断・ローカルプライバシー — xMatrix ドキュメント"
description: "ローカルに残るデータ、Hub に送られるデータ（およびエンドツーエンド暗号化を行わない理由）、オプションのクォータ照会やクライアント診断の仕組みと無効化手順。"
---

# テレメトリとローカルプライバシー

xMatrix はホスト型コラボレーション Hub と、ご自身のマシン上で動く Rust ローカルデーモンで構成されています。このページでは信頼境界（ローカルに残るデータ、Hub に送られるデータ、チャンネルや Pages がエンドツーエンド暗号化ではない理由）と、クライアント・デーモンが行うすべての診断送信やローカル読み取りおよび無効化方法を明記します。

## マシン上に残るデータ

ソースコード、Git 履歴、作業ディレクトリ、未コミットのファイル、SSH 鍵、プロバイダの会話履歴、およびローカルのモデル認証情報は、人や Agent・ツール・機能が明示的に投稿または添付しない限り、ご自身のマシン上に残ります。生の端末出力が Hub に継続保存されることはありません。ライブの **Instance Trace** はホストプロセスのメモリ内にのみ保持され（Instance ごとに最大 5,000 イベント、16 MiB、または 24 時間）、権限を持つ閲覧者の要求時にのみ転送されます。xMatrix が API キーや OAuth トークンを Hub へ送信したり、他ツールの認証情報から複数マシンを横断するユーザー追跡を行ったりすることはありません。

再インストール後も同じマシンをアカウント内で安定して識別できるよう、デーモンはローカルで xMatrix ユーザー ID と OS マシン識別子をハッシュ化してアカウント単位の `machineId` を生成します。生のハードウェア識別子やアカウント非分離のフィンガープリントが Hub に送信されることはありません。

## Hub に送られるデータと、エンドツーエンド暗号化を行わない理由

**通信暗号化と保存時暗号化は実施していますが、エンドツーエンド暗号化（E2EE）ではありません。** クライアント、ローカルデーモン、xMatrix Hub 間の通信は HTTPS/TLS で保護され、Hub の保存先（PlanetScale のマネージド PostgreSQL、Cloudflare Durable Objects、非公開 R2 オブジェクトストレージ）では保存時暗号化が行われます。Saved Secrets の値には保護された鍵による認証付き暗号化も適用されます。**チャンネルのメッセージ、Pages、添付ファイルはエンドツーエンド暗号化ではありません。**

**エンドツーエンド暗号化を行わない理由。** 単一ユーザー向けの端末トンネルとは異なり、xMatrix は複数人と複数 Agent が共同作業するホスト型ワークスペースです。Hub がコラボレーション内容を解釈できることで、以下の機能を提供しています：

- メンバーや複数デバイス間でのチャンネル・スレッド・Pages のリアルタイム同期
- チャンネルおよび Pages のインデックス作成と全文検索
- `@auto` による適切な Agent・リポジトリへのルーティング、会話と Page の自動紐付け、プロバイダ横断の自動引き継ぎ
- Page 内の自動化プログラム（`norn` プログラム）の実行と、GitHub・Gmail・Linear・Sentry など外部アプリの Webhook 処理

**Hub に送られるもの：** チャンネルのメッセージ、スレッド、Pages、添付ファイル、Space／Agent／マシンのメタデータ、正規化されたクォータ情報、連携アプリの実行結果、暗号化保存された Saved Secrets（平文の値はメッセージや Agent 一覧に表示されず、`auto` または実行ごとの `ask` 承認ポリシーに従ってのみ Run へ注入されます）。

**マシン接続と内部アクセスの境界：**

- マシンの接続にはサインイン済み所有者による明示的な承認が必要であり、既定で開いた常時トンネルではありません。マシンはいつでも切断でき、実行中の Agent も即座に停止できます。外部コネクタはアプリごとに「読み取り専用／毎回確認／読み書き」のポリシーで制御されます。
- Hub に保存された内容は、Space とチャンネルの権限を満たすメンバーおよび Agent のみが閲覧できます。xMatrix のスタッフとサポート Agent は、ユーザーが明示的に会話をサポートへ引き渡した場合を除き顧客の会話を読みません（下記「[会話を xMatrix サポートに渡す](#会話を-xmatrix-サポートに渡す)」を参照）。製品分析には本文を含まないメタデータのみを使用します。

## ローカルのプロバイダクォータ照会

**要約:** 登録した AI ツールの残りクォータを表示するため、xMatrix daemon はお使いのコンピュータ上にあるそれらのツール自身のログインファイル（例: `~/.grok/auth.json`）を読み取り、各プロバイダに直接問い合わせます。Codex、Claude Code、OpenCode は例外で、xMatrix はツール自身に問い合わせ、それらのログインファイルは開きません。Codex には実行中のセッションまたは一時的に起動した `codex app-server` を通じて、Claude Code には実行中のセッションまたは一時的に起動した `claude` を通じて（プロンプトを送らない `get_usage` リクエスト）、OpenCode には一時的に起動した `opencode serve` を通じて問い合わせます。これらのファイルから読み取った内容（トークン、アカウント ID、ファイル内容、ファイルのフィンガープリント）は一切 xMatrix に送信されず、Hub が受け取るのは正規化されたクォータ情報のみです。1 つのスイッチでファイルの読み取り、Codex・Claude Code・OpenCode へのリクエスト、プロバイダへのリクエストをすべて停止できます（下記「ローカルクォータ照会を無効にする」を参照）。公式のクォータ照会手段がないツール（Cursor など）は、そのコンピュータで許可するまで一切読み取られません（下記「許可した場合にだけ読み取るツール」を参照）。公式のクォータ取得手段がない OpenCode 2.2.0 より前のバージョンも、そのコンピュータで許可するまで一切読み取りません。

登録済みのハーネス（Claude Code、Codex、Cursor、Grok、OpenCode、DeepSeek、Z.ai、Antigravity 等）について、`xmatrix agent list` や Agents 画面で残量を表示し、`@auto` ルーティングで上限到達アカウントを避けるために、ローカルデーモンが登録済みツールのローカル認証ストアを読み取り各プロバイダの残量 API を直接照会する場合があります。

| ハーネス | ローカルメモリのみで読む保存先 | マシンから直接問い合わせるプロバイダ API |
| --- | --- | --- |
| Claude Code | 読み取りなし: Claude Code 自身の `get_usage` 制御リクエスト（実行中のセッションまたは一時的に起動した `claude`）。プロンプトは送信しません | Claude Code が自身のサインインで処理 |
| Codex | 読み取りなし: Codex 自身の app-server メソッド `account/rateLimits/read`（実行中のセッションまたは一時的に起動した `codex app-server`） | Codex が自身のサインインで処理 |
| Cursor（そのコンピュータで許可した場合のみ） | `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`、macOS キーチェーン（`cursor-access-token`）、または Cursor `auth.json` | `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| Grok Build | `GROK_CLI_OAUTH_TOKEN` または `~/.grok/auth.json` | `https://cli-chat-proxy.grok.com/v1/billing?format=credits` |
| OpenCode 2.2.0 以降 | 読み取りなし: 一時的に起動した `opencode serve` の `GET /api/experimental/usage/limits`（ループバックのみで待ち受け、一回限りのパスワードを使用）。OpenCode が他のプロバイダにルーティングするモデルでは何も読み取りません | OpenCode が自身のサインインで処理 |
| OpenCode 2.2.0 より前（そのコンピュータで許可した場合のみ） | `OPENCODE_API_KEY` または OpenCode の `auth.json` の `opencode-go` エントリ | `https://opencode.ai/zen/go/v1/usage` |
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

OpenCode 2.2.0 より前のバージョンにも公式のクォータ取得手段がないため、同じ扱いです。許可がなければ、xMatrix は OpenCode の `auth.json` も、そのために設定された `OPENCODE_API_KEY` も開かず、OpenCode のエンドポイントにも問い合わせず、クォータは **Unknown** と表示されます。許可すると（**Allow reading OpenCode sign-in to show quota**、または `xmatrix config quotaAccess opencode on`）、xMatrix は OpenCode が OpenCode Go 用に保存したキーだけを読み、`https://opencode.ai/zen/go/v1/usage` への 1 回のリクエストにだけ使います。期限切れのサインインを OpenCode に代わって更新することはありません。OpenCode に再度サインインするまで、クォータは不明（期限切れ）と表示されます。上記のアカウントとの紐付け、取り消し、全体スイッチはそのまま適用されます。OpenCode 2.2.0 以降では、xMatrix は `opencode serve` に問い合わせ、許可の有無にかかわらず OpenCode の資格情報を読みません。

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
- **CLI と daemon**：`xmatrix config telemetry on` または `XMATRIX_TELEMETRY=1` でオン、`xmatrix config telemetry off`、`XMATRIX_TELEMETRY=0`、`DO_NOT_TRACK=1` でオフ。`xmatrix config telemetry on|off` は選択をアカウントにも保存します。

## 会話を xMatrix サポートに渡す

xMatrix のスタッフと Agent があなたの会話を読むのは、あなたがその会話をサポートに渡したときだけです。製品分析にはメタデータだけを使い、あなたが書いた内容は使いません。

助けが必要なときは、会話のメニュー、xMatrix が投稿する障害通知（起動の失敗、繰り返す失敗、数分間進捗がない）、または会話を開いた状態の **Help → Report an issue** から **Hand to xMatrix support** を選びます。そのうえで:

- 何が起きたかを一行で書きます。
- 含める内容にチェックを入れます。最初は何もチェックされていません:
  - **This conversation's messages**（スレッドを含む）。
  - **Diagnostics for this conversation**: Agent がここでいつ起動・停止・失敗したかと、その失敗コード。状態・コード・回数・時刻だけからなる診断イベントで、メッセージ本文、プロンプト、エラーメッセージ、ID は含みません。
  - **Daemon logs**: オンラインになっているあなたのマシンで xMatrix のデーモンが最近書いたログの末尾。ホームフォルダーのパス、メールアドレス、Web アドレスのクエリ部分、トークンや鍵のような文字列は、マシンから出る前にそのマシン上で取り除かれ、送信前にダイアログで送られる内容をそのまま確認できます。プレビューは約 1 週間、あなただけが読めます。送信したログは、引き継ぎを取り消した時点で消去されます。
- **I agree to let xMatrix support read what I selected** にチェックを入れます。チェックするまで何も送信されません。

渡したときに許されること:

- **誰が読むか:** xMatrix サポート、つまり xMatrix チームとそのサポート Agent が、この引き継ぎ用に開かれたサポート会話の中で対応します。
- **読み取り専用:** サポートはあなたがチェックした内容を、あなたに見えるとおりに読むだけで、あなたの会話に書き込んだり、反応したり、何かを起動したりはできません。サポートの回答は「xMatrix support」からのメッセージとしてあなたの会話に届くか、メールで届きます。
- **期間:** 14 日間。あなた、またはスペースのオーナーか管理者は、会話に残る案内の **Withdraw now** でいつでも取り消せます。取り消しや期限切れの時点で読み取りは止まります。
- **読まれたことがわかる:** サポートが 1 時間のうちに初めて読んだとき、あなたの会話に「xMatrix support read this conversation」と時刻が表示されます。その 1 時間に続けて読むたびに同じ表示が更新され、読んだ回数と最後に読んだ時刻が示されます（例: 「xMatrix support read this conversation 3 times (latest 14:05 UTC)」）。次の 1 時間は新しい表示になります。
- 会話を渡せるのは、その会話を始めた人、またはそのスペースのオーナーか管理者だけです。

## 法的文書

- [プライバシーポリシー (EN)](/privacy)
- [Cookie・ローカルストレージ通知 (EN)](/cookies)
- [復委託先一覧 (EN)](/subprocessors)
- [利用規約 (EN)](/terms)
