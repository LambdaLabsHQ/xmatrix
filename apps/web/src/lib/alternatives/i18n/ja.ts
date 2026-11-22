import type { AlternativeLocaleCopy, AlternativeSlug } from "../types";

export const alternativesCopyJa: Readonly<Record<AlternativeSlug, AlternativeLocaleCopy>> = {
  raft: {
    alsoKnownAs: "旧 Slock",
    verifiedDate: "2026年11月22日",
    metaTitle: "Raft 代替 (2026)：Raft vs xMatrix",
    metaDescription:
      "Raft（旧 Slock）の代替ツールをお探しですか？埋もれるチャットや廃止された Wiki Agent の代わりに、生きたページ、35 種類のコーディングエージェント、35 の連携アプリを備える xMatrix と比較します。",
    eyebrow: "Raft 代替 · Raft vs xMatrix",
    headline: "決定事項がチャットに埋もれず「生きたページ」に残る Raft 代替ツール",
    lead: "Raft はコーディングエージェントをチャットのチームメイトとして扱い、2026年9月に Wiki Agent を廃止しました。xMatrix は人と 35 種類のコーディングエージェントの共有チャンネルを残しつつ、完了した作業をすべてのマシンと 35 の連携アプリを横断する「生きたページ」へ集約し、常に最新に保ちます。",
    productCaption:
      "xMatrix の画面：人とコーディングエージェントがチャンネルで協業しながら、チャット履歴やマシンごとの MEMORY.md に分散させず、1 つの生きたプロジェクトページを最新に保ちます。",
    painPoints: [
      {
        title: "作業結果がチャット履歴とマシンごとの MEMORY.md に閉じ込められる",
        problem:
          "Raft は 2026年9月24日に Wiki Agent を廃止し、各エージェントの記憶は 1 台のマシンのローカルな MEMORY.md や notes/ に縛られています。初期に誤った前提が記録されると人が手で掃除するまで古い文脈が残り続け、Free プランではワークスペース履歴も 30 日で切れます。",
        xmatrixAnswer:
          "xMatrix では「生きたページ」がプロダクトの主成果物です。作業が完了するとエージェントが該当セクションを書き換え、人が同じ段落を編集すればエージェントは待機して人の記述を引き継ぎます。",
      },
      {
        title: "Stamp は GitHub 止まり。運用系コネクタを横断する承認レイヤーがない",
        problem:
          "Raft の Stamp は GitHub のプッシュや PR への承認を追加しますが、実運用のソフトウェア開発では Vercel、Cloudflare、Linear、Sentry、Gmail、Stripe、Google Workspace も操作します。Raft のエージェントランタイムはそれ以外の権限チェックをバイパスして起動します。",
        xmatrixAnswer:
          "xMatrix は 35 の連携アプリに統一されたアプリ別ポリシー（読み取り専用 / Ask first / 読み書き — GitHub は読み取り専用・読み書きの 2 段階）を適用し、Space シークレットも xmatrix secret exec で注入するためエージェントが生値を読むことはありません。",
      },
      {
        title: "Pro ではエージェントにも席料がかかり、1 台のマシンに固定される",
        problem:
          "Raft Pro（人 1 席あたり月額 $10、年払いで $8.80）ではエージェント 1 体ごとに 0.1 席分が課金され、各エージェントは 1 台のマシンに固定されます。そのノート PC がオフラインになるとエージェントも止まります。",
        xmatrixAnswer:
          "xMatrix は登録したすべての macOS・Windows・Linux マシン上で 35 種類のコーディングエージェント（および --runtime による任意のカスタム CLI）をエージェント席料 $0 でサポートし、適性と余力に応じてタスクをルーティングします。",
      },
    ],
    comparisonRows: [
      {
        dimension: "プロジェクトの最新状態の置き場所",
        xmatrix: "エージェントが最新化し人と共同編集する「生きたページ」",
        competitor: "チャットスレッド、番号付きタスク、マシンごとの MEMORY.md（Wiki Agent は廃止）",
      },
      {
        dimension: "承認とシークレット管理",
        xmatrix: "35 アプリ横断のアプリ別ポリシー + Space シークレット（GitHub：読み取り専用 / 読み書き）",
        competitor: "GitHub プッシュ/PR 向け Stamp、ローカルプロキシトークン、ランタイムは権限バイパス",
      },
      {
        dimension: "対応エージェントと料金",
        xmatrix: "35 種類のコーディングエージェント（+ --runtime）／Free（累計 500 書き込み）／Pro 月額 $10/人席（年払い $8）",
        competitor: "対応ランタイム少／Free（履歴 30 日）／Pro 月額 $10/席（年払い $8.80）+ 0.1 席/エージェント",
      },
      {
        dimension: "ルーティングと引き継ぎ",
        xmatrix: "@auto が適性とマシン余力で選択。クォータ上限時は別プロバイダーへ引き継ぎ",
        competitor: "エージェントごとに単一ランタイム固定。そのプロバイダーやマシンが止まると停止",
      },
      {
        dimension: "ソースコード公開状況",
        xmatrix: "FSL-1.1-ALv2 でソース公開",
        competitor: "ソースミラー公開（Enterprise SSO は未リリース）",
      },
    ],
    stayWhen: [
      "生きたドキュメントよりも、30 日間の無制限無料チャットを備えたチャット＆タスク型 IM の使い勝手を重視している。",
      "承認が必要な対象が Stamp でカバーされる GitHub のプッシュと PR だけに限られている。",
    ],
    switchWhen: [
      "何が本当にリリース済みかを確認するためにチャンネルを遡ったり、古びたローカルの MEMORY.md を直すのに疲れている。",
      "Vercel、Cloudflare、Linear、Sentry、Gmail、Stripe へ、共通の Space シークレットと承認ポリシーのもとでエージェントを安全にアクセスさせたい。",
      "0.1 席課金を気にせず、複数マシンにまたがる多数の特化型・一時的エージェントを運用したい。",
    ],
    migrationSteps: [
      {
        title: "既存のローカルリポジトリと CLI サブスクリプションをそのまま使う",
        detail:
          "Raft Computer を動かしている macOS・Windows・Linux ホストに xMatrix CLI をインストールするだけ。Claude Code・Codex・Cursor のログインは手元にそのまま残ります。",
      },
      {
        title: "チャンネルのピン留め情報を「生きたページ」へ昇格させる",
        detail:
          "稼働中のプロジェクトやプロダクトごとに 1 ページ作成し、エージェントごとに食い違う MEMORY.md の代わりに最新の決定事項を一元参照させます。",
      },
      {
        title: "API トークンを Space シークレットに移し、連携アプリを接続する",
        detail:
          "GitHub（読み取り専用または読み書き）に加え、Linear、Vercel、Cloudflare、Sentry を Ask first ルールで連携し、その他の認証情報は Space シークレットに安全に保管します。",
      },
    ],
    faqs: [
      {
        question: "どちらも人とエージェントのチャンネルを持っていますが、Raft と xMatrix の違いは何ですか？",
        answer:
          "Raft ではチャット履歴とタスクが最終記録になり、Wiki Agent も廃止されました。xMatrix では会話はあくまで作業場であり、決定事項・現状・残タスクの正式な記録は常に最新化される「生きたページ」に集約されます。",
      },
      {
        question: "xMatrix でも Raft Pro のようにエージェント 1 体あたり 0.1 席が課金されますか？",
        answer:
          "いいえ。Free でも Pro でもエージェントに席料は一切かかりません。Pro は人 1 席あたり月額 $10（年額 $96/席）で毎月 5,000 エージェントクレジットが付与され、人間による編集やメッセージ送信は無料です。",
      },
      {
        question: "xMatrix でも Raft のようなプライベートチャンネルは使えますか？",
        answer:
          "はい。Space 内でパブリックチャンネルとプライベートチャンネルの両方をサポートしており、Space シークレットやアプリ別の承認ポリシーと併用できます。",
      },
    ],
  },
  lody: {
    verifiedDate: "2026年11月22日",
    metaTitle: "Lody 代替 (2026)：Lody vs xMatrix",
    metaDescription:
      "Lody の代替ツールを比較中ですか？単一セッション worktree やデーモン同期切れから卒業し、共有マルチ人間チャンネル・生きたページ・Space シークレット・Webhook 自動化を備える xMatrix へ。",
    eyebrow: "Lody 代替 · Lody vs xMatrix",
    headline: "Lody の代替：1 つのチャンネル、1 つの生きたページをチーム全員とすべてのエージェントで共有",
    lead: "Lody はクローズドソースのクラウドリレー経由で 1 worktree＝1 セッションのスレッドを同期する設計です。xMatrix はチームメンバーと 35 種類のコーディングエージェントを 1 つの共有チャンネルに集め、成果が届くたびに生きたページを最新化し、Space シークレットやイベント駆動の Norn プログラムも備えています。",
    productCaption:
      "xMatrix の画面：孤立したコーディングセッションを 1 つずつ受け渡すのではなく、複数メンバーと 35 種類のコーディングエージェントが 1 つの共有チャンネルで協業し、成果を生きたページに統合します。",
    painPoints: [
      {
        title: "セッション中心の UX に共有チームチャンネルと生きたドキュメントがない",
        problem:
          "Lody は個別のコーディングセッションと子セッションツリーが中心です。セッションの引き渡しはできても、複数人＋複数エージェントの共有チャンネル、メンバー @メンション、共有プロジェクトドキュメントはコア機能ではなくロードマップ段階に留まっています。",
        xmatrixAnswer:
          "xMatrix は最初から複数人と複数エージェントが同じチャンネルで働く前提で設計されており、完了した各実行がプロジェクトの最新状態を保つ共有ページを更新します。",
      },
      {
        title: "デバイス間でのデーモン切断と worktree ロック競合",
        problem:
          "コミュニティの報告や GitHub トラッカー（LodyAI/Lody に 334 件のオープン Issue、日次デスクトップ E2E 追跡 #507 を含む）では、リモート npx lody デーモンのハートビート切断、サインインリンクのタイムアウト、並列 git worktree ロックエラー、ACP トランスクリプトのフリーズが報告されています。",
        xmatrixAnswer:
          "xMatrix は Hub の権限管理とローカルデーモン実行を分離し、上限付き結果アウトボックスと明示的な実行ライフサイクル遷移を備えるため、再接続時も状態を取り残さずクリーンに復旧します。",
      },
      {
        title: "ワークスペース単位のシークレット、アプリ承認ポリシー、Webhook 自動化がない",
        problem:
          "Lody の権限設定はセッション単位でワークスペース共通のシークレット保管庫がなく、運用ツール向けのアプリ別承認ガバナンスもありません。定期実行も cron のみで外部 Webhook トリガーには非対応です。",
        xmatrixAnswer:
          "xMatrix は実行時に安全注入される Space シークレット、35 の連携アプリに対するアプリ別承認コントロール、さらにスケジュールや GitHub・Sentry などの外部イベントで起動するページ埋め込み型の Norn プログラムを提供します。",
      },
    ],
    comparisonRows: [
      {
        dimension: "コラボレーションの基本単位",
        xmatrix: "複数人・複数エージェントのチャンネルに支えられた「生きたページ」",
        competitor: "個別セッションと子セッションツリー（1 セッションにつき 1 worktree）",
      },
      {
        dimension: "シークレットと外部運用ツール",
        xmatrix: "Space シークレット（xmatrix secret exec）+ 35 の連携アプリ（承認ポリシー付き）",
        competitor: "セッション単位の権限のみ。ワークスペース共通のシークレット保管庫なし",
      },
      {
        dimension: "自動化トリガー",
        xmatrix: "ページ内に組み込むスケジュール＆イベント駆動 Norn プログラム",
        competitor: "cron 定期タスクとクォータ回復再開のみ（Webhook トリガーなし）",
      },
      {
        dimension: "対応エージェントとルーティング",
        xmatrix: "35 種類のコーディングエージェント（+ --runtime）を適性・余力・クォータ引き継ぎでルーティング",
        competitor: "同じプロバイダーのクォータがリセットされるまで待機・再開",
      },
      {
        dimension: "料金",
        xmatrix: "Free（3 名まで・累計 500 書き込み）／Pro 月額 $10/席（年払い $8）",
        competitor: "Free（3 名・2 ワークスペース）／Plus 月額 $8/席（年払い）／Enterprise",
      },
    ],
    stayWhen: [
      "セッションツリー型モデルと iOS Dynamic Island 上でのロック画面承認フローを重視している。",
      "チームで調整したいのがコーディングセッションだけで、生きたドキュメントや Git 以外の運用コネクタを必要としない。",
    ],
    switchWhen: [
      "単一セッションを受け渡すのではなく、複数メンバーと異なるハーネスが 1 つのライブチャンネルで同時に協業したい。",
      "プロジェクト状況を最新に保つページ、Webhook 駆動ルーチン、Space シークレットが必要。",
      "デーモンの同期切れや worktree ロック競合でリモート複数マシン運用が滞っている。",
    ],
    migrationSteps: [
      {
        title: "同じマシンを xMatrix デーモンに登録する",
        detail:
          "既存の Claude Code、Codex、Kimi、ACP 対応 CLI をそのまま維持できます。xMatrix が自動検出し、既存サブスクリプションを置き換えずに登録します。",
      },
      {
        title: "セッションの行き来をプロジェクトページとチャンネルに統合する",
        detail:
          "稼働中の各リポジトリを Space ページに紐づけ、人とエージェントが 1 スレッドで連携して確定事項をページへ書き戻します。",
      },
      {
        title: "GitHub・Sentry・デプロイ系コネクタを追加する",
        detail:
          "外部イベントソースを接続し、手動でセッションを起動する代わりにルーチンが自動でエージェントを起こす構成へ移行します。",
      },
    ],
    faqs: [
      {
        question: "xMatrix でも Lody のように自分のマシン上でコーディングエージェントを動かせますか？",
        answer:
          "はい。エージェントは、あなたが登録した macOS・Windows・Linux コンピュータ（または自前サーバー）上のフォルダ・リポジトリ内で直接実行されます。",
      },
      {
        question: "プロバイダーのレート制限への対処は Lody とどう違いますか？",
        answer:
          "同じプロバイダーのリセットを待って一時停止する代わりに、xMatrix は Claude Code から Codex や Gemini など利用可能な別ハーネスへ会話を引き継いで作業を続けられます。",
      },
      {
        question: "xMatrix の同期サーバーも Lody のようにクローズドソースですか？",
        answer:
          "xMatrix は Hub・Web・CLI・クライアントのフルソースを FSL-1.1-ALv2 で公開しています（提供形態はセルフホストパッケージではなくセルフサーブのホスト型サービスです）。",
      },
    ],
  },
  multica: {
    verifiedDate: "2026年11月22日",
    metaTitle: "Multica 代替 (2026)：Multica vs xMatrix",
    metaDescription:
      "Multica の代替ツールを検討中ですか？ヘッドレスチケット実行、サイレントな bypassPermissions 脱落（#9559）、平文環境変数から卒業し、ライブチャンネル・生きたページ・Space シークレットを備える xMatrix へ。",
    eyebrow: "Multica 代替 · Multica vs xMatrix",
    headline: "Multica の代替：あらゆる依頼をチケット化しない — 一言伝えれば出荷され、生きたページが最新化",
    lead: "Multica はあらゆるエージェントタスクを bypassPermissions 既定のヘッドレスなカンバン Issue に押し込め、生きたドキュメント層を持ちません。xMatrix は人と 35 種類のコーディングエージェントがチャンネルでリアルタイムに協業し（xmatrix claude で対話セッションを接続可能）、生きたページを最新化し、35 の連携アプリを Space シークレットで統制します。",
    productCaption:
      "xMatrix の画面：見えないヘッドレスボード実行ではなく、共有チャンネルでチームメイトと一緒に Claude Code・Codex を含む 35 種類のコーディングエージェントをリアルタイムに舵取りし、明示的な承認と生きたページで統制します。",
    painPoints: [
      {
        title: "強制的な bypassPermissions 既定、制限のサイレント脱落、サーバーの平文環境変数",
        problem:
          "Multica は Claude Code を --permission-mode bypassPermissions、Codex を full-auto モードで起動し、サーバー環境変数を平文で保存します。コミュニティの不具合報告 #9559 では、custom_args がユーザー指定の --permission-mode 制限をサイレントに脱落させる問題も判明しました。",
        xmatrixAnswer:
          "xMatrix は 35 の連携アプリに対する外部操作をアプリ別の読み取り専用 / Ask first / 読み書きポリシーで統制し、Space シークレットを xmatrix secret exec で実行時注入するため、生の認証情報がサーバー環境変数やチャット履歴に露出することはありません。",
      },
      {
        title: "すべてをヘッドレスチケット化する必要があり、共有チャンネルも対話セッション接続もない",
        problem:
          "Multica のアプリ内チャットはプライベート 1 対 1 専用で、あらゆる作業をヘッドレスなボードチケットにする必要があります。実行途中でエージェントを軌道修正したり、稼働中のローカル端末セッションをチーム会話へ取り込んだりすることはできません。",
        xmatrixAnswer:
          "xMatrix ではチームメイトと 35 種類のコーディングエージェントが共有チャンネルでリアルタイムに協業でき、xmatrix claude を使えば既存のローカル端末セッションをそのままチャンネルに接続でき、成果は生きたページに集約されます。",
      },
      {
        title: "生きたページや内蔵プロジェクトメモリがない",
        problem:
          "Multica が管理するのは Issue とスキルであり、変化し続けるプロジェクトの最新状態ではありません。コミュニティのメモリ機能要望（#838）は 2026年4月から未解決のままで、決定事項がクローズ済みチケットに散らばります。",
        xmatrixAnswer:
          "すべての xMatrix Space に「生きたページ」が組み込まれています。決定事項は 1 か所に書かれ、人間と共同編集でき（提案モードと段落ごとの帰属表示に対応）、作業を行うエージェントが最新化し続けます。",
      },
    ],
    comparisonRows: [
      {
        dimension: "コラボレーションモデル",
        xmatrix: "共有マルチ人間＋マルチエージェントチャンネル + xmatrix claude セッション接続 + 生きたページ",
        competitor: "カンバン Issue ボード + ヘッドレス実行のみ + プライベート 1 対 1 チャット",
      },
      {
        dimension: "外部操作とシークレット",
        xmatrix: "35 アプリのアプリ別ポリシー + マスク済み Space シークレット（実行時注入）",
        competitor: "bypassPermissions 既定（#9559）、サーバー平文環境変数、MCP スキーマ承認",
      },
      {
        dimension: "生きたドキュメント",
        xmatrix: "エージェントが更新するネイティブページ（提案モード・帰属表示・人間編集優先）",
        competitor: "なし（メモリ機能要望 #838 は未解決）",
      },
      {
        dimension: "対応コーディングエージェント",
        xmatrix: "35 種類のコーディングエージェント（+ --runtime で任意のカスタム CLI 対応）",
        competitor: "28 の CLI ランタイム",
      },
      {
        dimension: "外部運用コネクタ",
        xmatrix: "35 の連携アプリ（GitHub、Linear、Vercel、Cloudflare、Sentry、Gmail、Stripe など）",
        competitor: "チャットブリッジ（Slack、Lark、DingTalk、WeCom、Telegram）+ MCP プラグイン",
      },
    ],
    stayWhen: [
      "社内ネットワーク上で Go + PostgreSQL のセルフホスト Issue ボード自動化を動かすこと自体が必須要件になっている。",
      "すでに全作業を独立したカンバンチケットとして回しており、DingTalk・WeCom・Lark 経由のトリガーに強く依存している。",
    ],
    switchWhen: [
      "見えないヘッドレスチケット実行ではなく、チームメイトと複数コーディングエージェントがリアルタイムに舵取りしながら協業したい。",
      "本番デプロイや運用ツールに対して、平文のサーバー環境変数や bypassPermissions デフォルトは許容できない。",
      "クローズされた Issue に埋もれるのではなく、決定事項や残タスクを生きたページに自動集約したい。",
    ],
    migrationSteps: [
      {
        title: "既存の開発者マシンをそのまま接続する",
        detail:
          "Multica デーモンが動いている同じマシンに xMatrix CLI をインストールすれば、ローカルの Claude Code・Codex・Cursor 環境がすぐ使えます。",
      },
      {
        title: "定期 Autopilot ジョブをページの Norn ルーチンへ移す",
        detail:
          "スケジュール・イベント駆動ルーチンを、最新化したいプロジェクトページ内に直接配置し、毎回の結果が全員の見るページへ反映されるようにします。",
      },
      {
        title: "平文の環境変数を Space シークレットへ置き換える",
        detail:
          "トークンを xMatrix Space シークレットに格納し、GitHub・Linear・Sentry・Vercel を明示的な承認ポリシー付きで連携します。",
      },
    ],
    faqs: [
      {
        question: "Multica のボードから移行した場合、Linear や GitHub Issues は引き続き使えますか？",
        answer:
          "はい。xMatrix は GitHub と Linear にネイティブ連携しているため、既存の課題管理ツールを捨てずにエージェントが Issue を読み、PR を出し、プロジェクトページを更新できます。",
      },
      {
        question: "xMatrix でも Claude Code が bypassPermissions で強制起動されますか？",
        answer:
          "いいえ。xMatrix はマシンアクセスと外部アプリ権限を明示的に統制します。連携アプリは Read only / Ask first / Read & write に対応し、Space シークレットがエージェントのトランスクリプトに平文で露出することはありません。",
      },
      {
        question: "xMatrix では複数のメンバーが同じエージェントをリアルタイムに見て指示を出せますか？",
        answer:
          "はい。人とエージェントが同じチャンネルを共有し、リアルタイムの進行状況や承認カードを確認しながら、リンクされたページを共同編集できます。",
      },
    ],
  },
  paradev: {
    alsoKnownAs: "旧 Superset",
    verifiedDate: "2026年11月22日",
    metaTitle: "Paradev (Superset) 代替 (2026)：Paradev vs xMatrix",
    metaDescription:
      "Paradev（旧 Superset）の代替ツールをお探しですか？macOS・Windows・Linux・Android 横断で共有チャンネル・生きたページ・35 アプリ承認を月額 $10/席で使える xMatrix へ。",
    eyebrow: "Paradev（旧 Superset）代替 · Paradev vs xMatrix",
    headline: "あらゆる OS のチームで使える Paradev（Superset）代替：共有チャンネル・生きたページ・月額 $10/席",
    lead: "Paradev（2026年10月に Superset から改称）は macOS 中心で、Team 協業は $60/ユーザー/月に跳ね上がり、リモートホスト公開でマシン全体が露出します。xMatrix は macOS・Windows・Linux・Android・Web に対応し、共有チャンネル・生きたページ・35 の連携アプリを人 1 席あたり月額 $10 で提供します。",
    productCaption:
      "xMatrix の画面：20 個のターミナルペインを行き来する代わりに、整理されたチャンネルと生きたページから数十の並列エージェント会話を落ち着いて監督できます。",
    painPoints: [
      {
        title: "ターミナルと worktree の乱立が人間の注意力にボトルネックを移す",
        problem:
          "Product Hunt や Reddit では Paradev の並列 worktree が高く評価される一方、多数の独立ターミナル・差分ペイン・重複ブランチを行き来することによる視覚的ノイズとレビュー疲労、さらにクラウド自動化の上限設定がないことによる LLM 課金の暴走が繰り返し指摘されています。",
        xmatrixAnswer:
          "xMatrix は「全ターミナルを監視する」から「プロジェクトごとに 1 つの生きたページを読む」へ発想を転換します。会話は裏で進み、人間はページを確認し、判断や例外が必要なスレッドにだけ介入すれば済みます。",
      },
      {
        title: "リモートとチーム協業に対する $20〜$60/席の高いペイウォール",
        problem:
          "Paradev のローカルクライアントは無料（MIT）ですが、リモート機能は Pro（$20/ユーザー/月、年額 $192）、チーム協業は $60/ユーザー/月まで跳ね上がります。しかも既存の Anthropic や OpenAI のサブスクリプションとは別途必要です。",
        xmatrixAnswer:
          "xMatrix Pro は人 1 席あたり月額 $10（年払い $8/月）で、エージェント無制限・5,000 クレジット/席・複数マシンチャンネルが含まれ、チーム向けの上位プラン追加課金はありません。",
      },
      {
        title: "リレー開放でマシン全体が露出し、Space シークレットや運用コネクタがない",
        problem:
          "Paradev には Space 単位のシークレット管理やアプリ横断の承認レイヤーがなく、リモートリレーを許可すると事実上ホストマシン全体が認可メンバーに開かれます。",
        xmatrixAnswer:
          "xMatrix はエージェントの作業範囲を登録済みリポジトリ・フォルダに限定し、Space シークレットを生値非表示で注入し、35 の連携アプリにアプリ別ポリシーを適用します。",
      },
    ],
    comparisonRows: [
      {
        dimension: "チーム料金",
        xmatrix: "人 1 席あたり月額 $10（年払い $8/月）。3 名まで無料（累計 500 書き込み）",
        competitor: "Free（1 名ローカル）／Pro $20/ユーザー/月／Team $60/ユーザー/月（クラウド 150 時間）",
      },
      {
        dimension: "コアワークフロー",
        xmatrix: "共有チャンネル + 作業完了とともにエージェントが最新化する生きたページ",
        competitor: "並列 IDE/worktree ワークスペース + ピン留めコメント付き公開ページ",
      },
      {
        dimension: "エージェントの実行場所",
        xmatrix: "自分の macOS・Windows・Linux マシン（ノート PC・デスクトップ・自前サーバー）",
        competitor: "macOS 中心のローカル IDE、リモート SSH/リレーホスト、または Vercel クラウドサンドボックス",
      },
      {
        dimension: "シークレットと運用アプリ",
        xmatrix: "Space シークレット保管庫 + アプリ別承認ポリシー付き 35 の連携アプリ",
        competitor: "ワークスペース外インライン承認。Space シークレットなし、開発系トリガーのみ",
      },
      {
        dimension: "複数人のリアルタイムチャット",
        xmatrix: "ネイティブの複数人＋複数エージェント パブリック/プライベートチャンネル",
        competitor: "ワークスペースやページ上のコメントのみ。共有マルチエージェントチャンネルなし",
      },
    ],
    stayWhen: [
      "自分で VM を立てずにノート PC を閉じたまま動かし続けられる、Paradev のターンキーな Vercel クラウドサンドボックス自体を求めている。",
      "ビジュアルな worktree 差分確認と、要素ピン留めレビューコメントを中心にした IDE 型デスクトップアプリを好む。",
    ],
    switchWhen: [
      "自分のマシンで小規模チームを調整するためだけに、Claude/Codex 料金に加えて $20〜$60/席を払うのは割高だと感じる。",
      "20 個のターミナルタブを切り替える代わりに、20 本の並列エージェント作業が 1 枚の生きたページにまとまる体験がほしい。",
      "Git worktree だけでなく、Cloudflare・Vercel・Gmail・Stripe・Sentry・Google Workspace へ安全にエージェントを繋ぎたい。",
    ],
    migrationSteps: [
      {
        title: "macOS・Linux・Windows ホストを xMatrix に登録する",
        detail:
          "既存のワークステーションや自前の常時稼働 Linux サーバーを 1 つの Space に統合できます。macOS 専用クライアントの制約もありません。",
      },
      {
        title: "複数タブ監視をプロジェクトページに置き換える",
        detail:
          "1 つのページに紐づくチャンネルでエージェントを呼び出し、PR・テスト結果・決定事項が自動で集約される運用へ切り替えます。",
      },
      {
        title: "認証情報とアプリ権限を一元化する",
        detail:
          "連携アプリに Read only または Ask first を設定し、共有トークンを Space シークレットへ集約します。",
      },
    ],
    faqs: [
      {
        question: "xMatrix には Paradev Team のようなマネージドクラウドサンドボックスはありますか？",
        answer:
          "現時点ではありません。xMatrix はあなた自身が管理するコンピュータやクラウド VM（macOS・Windows・Linux）上でエージェントを実行します。常時稼働の VPS やビルドサーバーをお持ちなら、ノート PC と並べてクリーンに接続できます。",
      },
      {
        question: "xMatrix はどのようにして Paradev のようなターミナル乱立を防ぎますか？",
        answer:
          "数十枚の生ターミナルペインを監視させる代わりに、各会話が成果を「生きたページ」へ書き戻すため、数秒で全体の現在地を把握できます。",
      },
      {
        question: "Superset は Paradev に変わったのですか？",
        answer:
          "はい。Superset は 2026年10月に Paradev へリブランドされました（GitHub は ParadevAI/Paradev）。このページの情報はすべて 2026年11月22日時点の Paradev の最新料金と設計に基づいています。",
      },
    ],
  },
  conductor: {
    verifiedDate: "2026年11月22日",
    statusNote: "2026年11月に Meta に買収され、Conductor Cloud は 2026年11月20日に終了しました。",
    metaTitle: "Conductor 代替ツール (2026)：Meta 終了後の移行先 xMatrix",
    metaDescription:
      "Conductor は Meta に買収され、Conductor Cloud が 2026年11月20日に終了しました。macOS・Windows・Linux 対応、月額 $10/席で Claude Code・Codex チームを動かせる xMatrix へ移行しましょう。",
    eyebrow: "Conductor 代替 · Meta 買収後の移行ガイド",
    headline: "Meta による Conductor 終了後の移行先：Mac・Windows・Linux 対応＆生きたページを備える xMatrix",
    lead: "Meta は 2026年11月に Conductor を買収し、新規受付を停止したうえで 2026年11月20日に Conductor Cloud を終了しました（macOS 専用ローカルアプリも 2027年初頭までの保守のみ）。xMatrix は macOS・Windows・Linux 上で 35 種類のコーディングエージェントを使い続け、チームの文脈を生きたページに保てる独立した開発基盤です。",
    productCaption:
      "xMatrix の画面：Conductor からエクスポートしたリポジトリと Claude Code / Codex のログインをそのまま持ち込み、macOS・Windows・Linux・Android・Web 共通のワークスペースで再開できます。",
    painPoints: [
      {
        title: "Conductor Cloud は終了し、ロードマップも収束段階にある",
        problem:
          "2026年11月の Meta 買収後、Conductor Cloud は 11月13日に読み取り専用となり、2026年11月20日に完全終了しました。新規ユーザーは登録できず、開発チームが Meta Superintelligence Labs へ移るため、ローカルアプリも 2027年初頭までの重要修正のみとなっています。",
        xmatrixAnswer:
          "xMatrix は独立して活発に開発されており、ソース公開（FSL-1.1-ALv2）かつセルフサーブ課金で、大手テックの買収方針に振り回されない長期的な拠点になります。",
      },
      {
        title: "macOS 専用のロックインにより Windows・Linux メンバーが締め出されていた",
        problem:
          "Conductor は独立期間を通じて Windows や Linux のネイティブ対応を行わず、OS が混在する開発チームではツールを分けるか Mac を買い揃える必要がありました。",
        xmatrixAnswer:
          "xMatrix は macOS・Windows・Linux・Android・Web（iPhone・iPad 対応）で動作します。Linux ビルドサーバー、Windows 開発機、MacBook をまったく同じ Space に接続できます。",
      },
      {
        title: "生きたページがなく、終了前の料金も月額 $50〜$60 と高額だった",
        problem:
          "Conductor は Pro が月額 $50、Teams が $60/ユーザー/月と高額で、巨大な会話ログでの UI 遅延も課題でした。また、知見は共有の生きたドキュメントではなく孤立したワークスペース内に留まっていました。",
        xmatrixAnswer:
          "xMatrix Pro は人 1 席あたり月額 $10（年払い $8/月）で 35 種類のコーディングエージェントを無制限に利用可能。完了した作業を生きたページに反映し、35 の連携アプリと Space シークレットも備えます。",
      },
    ],
    comparisonRows: [
      {
        dimension: "プロダクト状況（2026年11月時点）",
        xmatrix: "活発に開発中・独立運営・新規受付中・ソース公開",
        competitor: "Meta 買収済み。Cloud は 2026年11月20日終了、新規受付停止",
      },
      {
        dimension: "対応 OS",
        xmatrix: "macOS・Windows・Linux・Android・Web（iPhone・iPad 対応）",
        competitor: "macOS・iOS のみ（Windows・Linux ネイティブ非対応）",
      },
      {
        dimension: "料金",
        xmatrix: "無料プラン（累計 500 書き込み）+ Pro 月額 $10/人席（年払い $8/月）",
        competitor: "終了前は Pro 月額 $50、Teams $60/ユーザー/月（終了に伴い返金）",
      },
      {
        dimension: "マルチエージェントの成果物",
        xmatrix: "生きたページ + 35 種類のコーディングエージェントと協業する共有チャンネル",
        competitor: "並列 worktree セッションと差分ビュー",
      },
      {
        dimension: "ガバナンスと連携アプリ",
        xmatrix: "35 アプリのアプリ別ポリシー + Space シークレット",
        competitor: "ローカルエージェントは OS ユーザー全権限で実行。運用承認レイヤーなし",
      },
    ],
    stayWhen: [
      "すでに Conductor Cloud のワークスペースを Mac ローカルへ退避済みで、2027年初頭までの一時的なつなぎだけを求めている。",
    ],
    switchWhen: [
      "11月20日に Conductor Cloud を失い、今すぐ Claude Code と Codex を複数マシンで動かせる現役ワークスペースが必要。",
      "チームに Mac だけでなく Windows や Linux マシンも混在している。",
      "見通しのよい月額 $10/席、生きたプロジェクトページ、GitHub・Linear・Vercel・Cloudflare への安全な連携を求めている。",
    ],
    migrationSteps: [
      {
        title: "Conductor から退避したローカルリポジトリをそのまま使う",
        detail:
          "Conductor の「Transfer to local」でエクスポートした Git リポジトリとブランチはすでにディスク上にあります。xMatrix はそのフォルダをそのまま扱えます。",
      },
      {
        title: "マシンと既存のサブスクリプションを接続する",
        detail:
          "Mac、Linux VPS、Windows マシンに xMatrix CLI を入れ、xmatrix agent add で既存の Claude Code・Codex・Cursor ハーネスを登録します。",
      },
      {
        title: "チーム用 Space を作り GitHub を連携する",
        detail:
          "チームメイトを招待し、プロダクト領域ごとに生きたページを作成すれば、macOS や特定ベンダーに縛られず並列エージェント運用を再開できます。",
      },
    ],
    faqs: [
      {
        question: "Conductor Cloud からエクスポートしたワークスペースを xMatrix へ移行できますか？",
        answer:
          "はい。ローカルへ転送した Git リポジトリや GitHub 上のリポジトリは、既存の Claude Code・Codex サブスクリプションのまま即座に xMatrix へ登録できます。",
      },
      {
        question: "xMatrix は macOS だけでなく Windows や Linux でも動きますか？",
        answer:
          "はい。macOS 専用だった Conductor と異なり、xMatrix は同じ Space 内で macOS・Windows・Linux マシンと Web・モバイルクライアントをすべてサポートします。",
      },
      {
        question: "xMatrix は Conductor Cloud のようにクラウド VM をホストしてくれますか？",
        answer:
          "xMatrix は独自のクラウドサンドボックスをバンドルせず、あなた自身のノート PC、社内サーバー、または好みのクラウド VM（Fly、AWS、Hetzner など）を接続する方式です。そのため外部クラウドのサービス終了で作業環境が失われる心配がありません。",
      },
    ],
  },
  orca: {
    verifiedDate: "2026年11月22日",
    metaTitle: "Orca 代替 (2026)：Orca vs xMatrix",
    metaDescription:
      "Orca（stablyai/orca）の代替ツールをお探しですか？単一ユーザー設計、RAM 急増、8,900 件超の未解決 Issue、不安定な LAN モバイル連携から離れ、マルチプレイヤーチャンネルと生きたページの xMatrix へ。",
    eyebrow: "Orca 代替 · Orca vs xMatrix",
    headline: "個人を超えたチームのための Orca 代替：1 つのチャンネル、1 つの生きたページ、最適なルーティング",
    lead: "Orca はローカルの並列 worktree へプロンプトを一斉送信できる人気オープンソース ADE ですが、マルチプレイヤー UI は未実装のままで、1 プロンプトの N 並列送信はトークン消費を倍増させ、大規模実行でローカル RAM も急増します。xMatrix は 35 種類のコーディングエージェントから最適なエージェントへルーティングし、チーム全員の生きたページを最新に保ちます。",
    productCaption:
      "xMatrix の画面：ペインごとの内蔵ブラウザによる RAM 急増を避けつつ、所有マシン全体へ並列コーディング作業を分散し、デスクトップやスマホから成果を静かに確認できます。",
    painPoints: [
      {
        title: "依然としてシングルプレイヤー設計。共有チャンネルもチーム ID も Space シークレットもない",
        problem:
          "Orca は 1 人の開発者がローカル艦隊を指揮する前提で作られており、マルチプレイヤー UI は未リリースです。実験的な Slack/Discord ブリッジも仲間の発言を受動的な文脈として扱うだけで、Space 共通のシークレット保管庫やアプリ別承認レイヤーがありません。",
        xmatrixAnswer:
          "xMatrix はネイティブにマルチプレイヤー設計です。複数メンバーとエージェントがパブリック／プライベートチャンネルを共有し、アプリ別ポリシーのもとで外部操作を承認し、Space シークレットを安全に共有できます。",
      },
      {
        title: "ローカル資源の急増、クラッシュ Issue の山積、UI とエージェント状態の乖離",
        problem:
          "stablyai/orca には 8,988 件のオープン Issue（うち 100 件以上がクラッシュ関連）があり、並列 xterm と内蔵 Chromium による激しい RAM/CPU スパイク、dev helper の権限エラー（#26498）、エージェントがファイル編集中なのに UI が「完了」と誤表示するフリーズ、さらに 1 プロンプトを 4〜5 エージェントに同時展開することによるクォータ急消費が頻発しています。",
        xmatrixAnswer:
          "xMatrix はペインごとにブラウザを埋め込んだり、無駄なファンアウト重複実行を強いたりしません。最適な登録マシンでクリーンに実行し、明示的な実行状態を配信し、結果を 1 枚の読みやすいページに集約します。",
      },
      {
        title: "壊れやすい LAN モバイルペアリングと、残らないプロジェクト記憶",
        problem:
          "Orca のモバイル連携はローカルネットワーク上の E2EE QR ペアリングに依存しており、企業 VPN や分離された Wi-Fi 環境で途切れがちです。また作業完了後に最新化され続けるプロジェクト Wiki も残りません。",
        xmatrixAnswer:
          "xMatrix は Hub 経由でセルラー回線・VPN・デスクトップのどこからでも安定接続でき、完了した作業をチーム全員が Web・デスクトップ・モバイルで読める生きたページへ定着させます。",
      },
    ],
    comparisonRows: [
      {
        dimension: "マルチプレイヤーと権限",
        xmatrix: "複数人＋複数エージェントチャンネル、ロール、Space シークレット、アプリ別承認",
        competitor: "単一ユーザー向けデスクトップ ADE。マルチプレイヤー UI 未実装、共有シークレットなし",
      },
      {
        dimension: "プロジェクトの最新状態",
        xmatrix: "エージェントが継続更新する生きたページ（人間編集を優先）",
        competitor: "worktree 差分と実験的 DAG オーケストレーション。生きたドキュメントなし",
      },
      {
        dimension: "モバイルとリモートアクセス",
        xmatrix: "どの VPN からでも使える Hub リレー型 Web（iPhone・iPad 対応）・デスクトップ・Android",
        competitor: "企業 VPN やファイアウォールで切れやすいローカルネットワーク QR ペアリング",
      },
      {
        dimension: "ルーティングとトークン消費",
        xmatrix: "@auto がスキル・CPU/RAM・クォータ余力から最適な 1 エージェントを選択",
        competitor: "ファンアウト送信で N 個の並列 worktree 分だけトークン消費が倍増",
      },
      {
        dimension: "運用コネクタ",
        xmatrix: "アプリ別ポリシー付きの 35 の連携アプリ + Space シークレット",
        competitor: "実験的 Slack/Discord 文脈ブリッジのみ。運用承認レイヤーなし",
      },
    ],
    stayWhen: [
      "1 つのプロンプトを 4 モデルへ同時投入し、内蔵ブラウザ付きで視覚的差分を見比べたい個人開発者である。",
      "ホスト型 Hub を一切介さない 100% MIT ライセンスのローカルデスクトップ IDE にこだわりたい。",
    ],
    switchWhen: [
      "同じワークスペースで個別のユーザー ID・通知・承認権限を持ってチームメイトと協業したい。",
      "ローカルのブラウザ／worktree 並列実行がノート PC のメモリを圧迫したり、Claude/OpenAI の上限を焼き切っている。",
      "VPN やモバイル回線越しでも確実に操作でき、プロジェクトの現在地が 1 枚の生きたページでわかる環境がほしい。",
    ],
    migrationSteps: [
      {
        title: "手元の PC と余っているビルドサーバーをまとめて接続する",
        detail:
          "1 台のノート PC のメモリを圧迫する代わりに、MacBook と Linux サーバーを同じ xMatrix Space へ登録して実行を分散します。",
      },
      {
        title: "既存の CLI ハーネスをそのまま使う",
        detail:
          "xmatrix agent add で Claude Code・Codex・Kimi・Cursor を一度登録するだけ。独自ランタイムへの再認証は不要です。",
      },
      {
        title: "リポジトリを生きたページに紐づける",
        detail:
          "生のターミナルタブを見比べる代わりに、PR・CI 結果・決定事項をエージェントに共有ページへ集約させます。",
      },
    ],
    faqs: [
      {
        question: "Orca は Issue 数が多いのに GitHub スター数が非常に多いのはなぜですか？",
        answer:
          "Orca はエージェントを 35 回起動するとアプリ内でワンクリックのスター付与を促す仕組みがあり、8,988 件のオープン Issue と並行してスター数が 132k を超えました。日々の安定性とマルチプレイヤー統制が必要かどうかで比較することをおすすめします。",
      },
      {
        question: "xMatrix は企業 VPN やモバイル回線越しでも動作しますか？",
        answer:
          "はい。ローカルデーモンが xMatrix Hub へアウトバウンド接続を維持するため、外出先のスマートフォンからでもページ閲覧・指示送信・コネクタ承認が安定して行えます。",
      },
      {
        question: "xMatrix でも複数エージェントを並列実行できますか？",
        answer:
          "はい。1 台または複数台の登録マシン上で数十の会話を並列実行でき、それぞれの進捗と最終成果がプロジェクトページに集約されます。",
      },
    ],
  },
  lobehub: {
    alsoKnownAs: "旧 LobeChat",
    verifiedDate: "2026年11月22日",
    metaTitle: "LobeHub (LobeChat) 代替 (2026)：LobeHub vs xMatrix",
    metaDescription:
      "LobeHub（旧 LobeChat）の代替ツールをお探しですか？クレジット転売の上乗せ、2.0 の PostgreSQL/S3 構築負担、RAG チャンク汚染を避け、既存コーディング契約をそのまま活かせる xMatrix へ。",
    eyebrow: "LobeHub（旧 LobeChat）代替 · LobeHub vs xMatrix",
    headline: "LobeHub の代替：Claude Code / Codex 契約済みチームへ — クレジットの二重払いをやめる",
    lead: "LobeHub（LobeChat から改称）はモデルクレジット転売で収益化する汎用 AI ワークスペースで、2.0 以降はセルフホスト構成も重く、複数人＋複数エージェントの共有チャンネルもありません。xMatrix は既存サブスクリプションのまま実リポジトリで 35 種類のコーディングエージェントを動かし、成果検証の Goals と 35 の連携アプリを備えています。",
    productCaption:
      "xMatrix の画面：トークン転売や Docker スタック保守なしで、手元の Claude Code・Codex・Cursor 契約をリアルタイムチームチャンネルと生きたページで協調運用できます。",
    painPoints: [
      {
        title: "クレジット転売モデルが長いコーディング文脈で予測不能に消費される",
        problem:
          "LobeHub Cloud の無料枠（約 500k クレジット）は多くの最先端モデルを制限しており、有料プラン（月額 $12.9 / $24.9 / $49.9）もすべてのトークンをクラウドクレジットで従量課金します。長いコード文脈や深掘りリサーチで想定より遥かに速くクレジットが尽きるという声が多く見られます。",
        xmatrixAnswer:
          "xMatrix は LLM トークンを一切転売・上乗せしません。エージェントはあなたがすでに契約している Claude Code・Codex・Cursor・Gemini のサブスクリプションや API キーで直接動き、xMatrix Pro は人 1 席あたり定額月額 $10 です。",
      },
      {
        title: "重い 2.0 アーキテクチャ移行と使えなくなったセルフホスト手順",
        problem:
          "LobeChat から LobeHub 2.0 への大規模刷新で PostgreSQL、S3 互換オブジェクトストレージ、新認証フローが必須になり、LobeHub Community License へ移行したことで、従来の 1.x Docker Compose 手順が壊れセットアップ負荷への不満が広がりました。",
        xmatrixAnswer:
          "xMatrix の導入にセルフホスト DB も S3 バケットも不要です。サインインしてマシンに軽量 CLI を 1 つ入れれば、数分で既存リポジトリと接続できます。",
      },
      {
        title: "リアルタイムの複数人＋複数エージェント開発ルームがなく、RAG 汚染も起きやすい",
        problem:
          "LobeHub にはエージェントグループとナレッジベースがありますが、ベクトル検索が無関係なチャンクを文脈に混ぜてしまう問題が起きやすく、複数エンジニアと複数ローカルコーディングエージェントが一緒にリリースを進めるライブ空間もありません。",
        xmatrixAnswer:
          "xMatrix は曖昧な RAG チャンク分割の代わりに、人間が読める「生きたページ」とライブな複数人チャンネルを採用。エージェントは古いベクトル断片ではなく現在の確定事項を直接読みます。",
      },
    ],
    comparisonRows: [
      {
        dimension: "モデル・トークン課金",
        xmatrix: "既存サブスクリプション／API キー持ち込み。トークン上乗せ $0、Pro は月額 $10/人席",
        competitor: "Cloud はモデルクレジット転売（月額 $12.9〜$49.9）。無料枠は最先端モデル制限",
      },
      {
        dimension: "複数人＋複数エージェントの空間",
        xmatrix: "チームメイトと複数コーディングハーネス向けのパブリック／プライベートチャンネル",
        competitor: "リーダー主導の Agent Groups。外部チャットは Discord/Slack/Lark ボット経由",
      },
      {
        dimension: "ナレッジモデル",
        xmatrix: "エージェントと人がその場で編集する生きた Markdown ページ",
        competitor: "ベクトルナレッジベース（チャンク汚染が起きやすい）+ 編集ロック付きページ",
      },
      {
        dimension: "導入・保守負荷",
        xmatrix: "ホスト型 Hub + マシン上の単一ネイティブ CLI デーモン",
        competitor: "Cloud SaaS、またはセルフホスト PostgreSQL + S3 + 認証スタック（2.0 移行）",
      },
      {
        dimension: "成果検証とガバナンス",
        xmatrix: "Goals が毎ターン後に完了条件を検証 + 全エージェント共通の 35 の連携アプリ統制",
        competitor: "内蔵の成果チェックあり。lh connect の外部コーディングエージェントはガバナンス外",
      },
    ],
    stayWhen: [
      "Anthropic や OpenAI の個別契約を持たず、40 以上のホスト型チャットモデルを 1 つのクレジット請求にまとめたい汎用 AI ポータルを求めている。",
      "LobeHub 標準の Discord・Telegram・WeChat・Lark ボット連携や、メンバー／エージェント別の予算ダッシュボードを活用している。",
    ],
    switchWhen: [
      "すでに Claude Code・Codex・Cursor に課金しており、長いコード文脈でクレジット転売の上乗せを二重に払いたくない。",
      "RAG 検索のチューニングに悩むのではなく、エンジニアと 35 種類のコーディングエージェントが共有チャンネルで協業し、正確な生きたページを維持したい。",
      "ローカルコーディングエージェントを連携させるためだけに PostgreSQL + S3 構成を保守したくない。",
    ],
    migrationSteps: [
      {
        title: "ネイティブのコーディング CLI と契約をそのまま活かす",
        detail:
          "35 種類のコーディングエージェント（Claude Code・Codex・Gemini・Cursor など）を xMatrix に直接登録し、ホスト型クレジットプールへの二重課金を止めます。",
      },
      {
        title: "静的なナレッジベースを生きたページと Goals へ移す",
        detail:
          "重要な設計メモや残タスクを xMatrix ページへ取り込んでエージェントに最新化させつつ、/goal で完了条件を自動検証します。",
      },
      {
        title: "アプリ別ガバナンス付きで運用アプリを連携する",
        detail:
          "GitHub（読み取り専用または読み書き）に加え、Linear、Vercel、Cloudflare、Sentry、Gmail を読み取り専用 / Ask first / 読み書きルールで接続します。",
      },
    ],
    faqs: [
      {
        question: "xMatrix も LobeHub Cloud のように AI モデルクレジットを転売していますか？",
        answer:
          "いいえ。エージェントはあなた自身の既存サブスクリプションや API キーで動作します。xMatrix Pro のクレジット（月額 $10/人席で 5,000 エージェントメッセージ／ページ更新）は協調基盤のみを対象とし、LLM トークンの転売は一切行いません。",
      },
      {
        question: "xMatrix はどのようにしてナレッジベースの検索汚染を防ぎますか？",
        answer:
          "文書を不透明なベクトルチャンクに細切れにする代わりに、簡潔な生きたページとして構造化し、アウトラインとセクション単位の段階的読み込みでエージェントが正確な現在情報だけを読むようにします。",
      },
      {
        question: "xMatrix でもツールごとの承認やシークレット管理はできますか？",
        answer:
          "はい。すべての連携アプリで Read only / Ask first / Read & write を設定でき、Space シークレットはエージェントに値を見せずコマンド実行時のみ注入されます。",
      },
    ],
  },
  cumora: {
    verifiedDate: "2026年11月22日",
    metaTitle: "Cumora 代替 (2026)：Cumora vs xMatrix",
    metaDescription:
      "Cumora（yetone/cumora）の代替ツールをお探しですか？オフラインサンドボックスの遮断（#350）、bwrap エラー、招待制プレビューを避け、本物のローカルリポジトリで動く xMatrix へ。",
    eyebrow: "Cumora 代替 · Cumora vs xMatrix",
    headline: "本物のリポジトリで動き、承認制コネクタで出荷できる Cumora 代替ツール",
    lead: "Cumora はペルソナ型エージェントをチームチャットに持ち込みますが、ローカル BYOA 実行を実作業から隔離したオフラインサンドボックスに閉じ込め、Bubblewrap や CDN 取得の不具合（#350）を抱えたまま招待制プレビューに留まっています。xMatrix は 35 種類のコーディングエージェントを実リポジトリ上で直接実行し、35 の連携アプリと生きたページで出荷まで完結します。",
    productCaption:
      "xMatrix の画面：招待待ちもオフラインサンドボックスの壁もなし。手元の本物の Claude Code・Codex ハーネスが、実際のリポジトリ上でチームと直接協業します。",
    painPoints: [
      {
        title: "オフラインサンドボックスの壁が実開発ワークフローと CDN アセットを壊す",
        problem:
          "Cumora の BYOA モードはローカル CLI を外部ネットワーク既定遮断の隔離サンドボックス内で動かすため、外部パッケージやドキュメント、さらには自身のチャット添付ファイル取得まで失敗します（Issue #350）。また実際の作業ディレクトリとも分断されます。",
        xmatrixAnswer:
          "xMatrix はあなたがマシン上に明示登録したリポジトリやフォルダの中で直接エージェントを実行するため、ローカルのツールチェーン、Git リモート、テストスイートがそのまま正常に動きます。",
      },
      {
        title: "Bubblewrap の起動失敗、クラウドとローカルの挙動差、未完成なモバイルクライアント",
        problem:
          "ローカルでの bwrap 起動エラー、Cumora Cloud の Kubernetes FUSE Pod とローカル BYOA ホスト間の挙動差、「coming soon」表示が残るモバイル画面が課題となっており、リポジトリへのコミットも 2026年11月1日以降止まっています。",
        xmatrixAnswer:
          "xMatrix は macOS・Windows・Linux・Android・Web（iPhone・iPad 対応）すべてで継続リリースを続けており、一貫したローカルマシン実行モデルを本番運用レベルで提供します。",
      },
      {
        title: "リリースと運用のための承認制コネクタが不足している",
        problem:
          "Cumora にはチャット・ドキュメント・カンバン・カレンダーの基本機能はあるものの、GitHub・Vercel・Cloudflare・Linear・Sentry・Gmail・Stripe を横断する承認レイヤーや Space シークレット保管庫がありません。",
        xmatrixAnswer:
          "xMatrix は 35 の連携アプリ（開発・ビジネスサービス）をアプリ別ポリシーと Space シークレット付きで連携します。",
      },
    ],
    comparisonRows: [
      {
        dimension: "ローカルエージェントの作業場所",
        xmatrix: "35 種類のコーディングエージェントを登録済みの実ローカルリポジトリとツールチェーン上で直接実行",
        competitor: "Cumora 独自のオフラインサンドボックス内（外部取得を遮断、#350）",
      },
      {
        dimension: "利用可否と開発継続性",
        xmatrix: "誰でも使えるセルフサーブ Free（累計 500 書き込み）& Pro プラン。日々活発にリリース",
        competitor: "招待制プレビュー。2026年11月1日以降リポジトリ更新なし",
      },
      {
        dimension: "外部アプリガバナンス",
        xmatrix: "アプリ別ポリシー付き 35 の連携アプリ + Space シークレット",
        competitor: "本番デプロイ承認のみ。同等の運用コネクタ承認レイヤーなし",
      },
      {
        dimension: "生きたプロジェクトドキュメント",
        xmatrix: "人と共同編集し、稼働中の実行が自動更新するページ",
        competitor: "ペルソナチャットに併設されたドキュメント・カンバン・カレンダー",
      },
      {
        dimension: "モバイルとクロス OS 対応",
        xmatrix: "macOS・Windows・Linux・Android・Web（iPhone・iPad 対応）",
        competitor: "デスクトップ／Web 中心。モバイルは「coming soon」状態の未実装あり",
      },
    ],
    stayWhen: [
      "招待制プレビュー期間中に、Cumora Cloud のマネージド Kubernetes Pod 側で推論コストを肩代わりしてもらうこと自体が目的である。",
      "ローカルリポジトリから切り離されたゼロネットワークのサンドボックス内でペルソナ型チャットエージェントを動かしたい。",
    ],
    switchWhen: [
      "オフラインサンドボックスのエラーに悩まされず、本物のリポジトリ・依存パッケージ・テスト環境でそのままエージェントを動かしたい。",
      "招待制プレビューではなく、今すぐオープンに使えて活発に更新されているワークスペースが必要。",
      "GitHub、Linear、Vercel、Cloudflare、Sentry、Gmail への承認制アクセスを 1 つの Space に統合したい。",
    ],
    migrationSteps: [
      {
        title: "ウェイトリストなしですぐ始める",
        detail:
          "数秒で無料の xMatrix Space を作成できます（3 名まで・エージェント無制限）。",
      },
      {
        title: "既存のローカルリポジトリとハーネスを登録する",
        detail:
          "Mac・Linux・Windows ホストで xmatrix agent add を実行し、コードがある実ディレクトリで Claude Code・Codex・Cursor を動かします。",
      },
      {
        title: "進行中の文脈を生きたページへ集約する",
        detail:
          "ペルソナチャットやカンバンボードに分散させる代わりに、決定事項・リリース状況・残タスクをページで最新に保ちます。",
      },
    ],
    faqs: [
      {
        question: "xMatrix も Cumora のようにローカルコーディングエージェントの外部通信を遮断しますか？",
        answer:
          "いいえ。エージェントは登録済みのローカル環境で通常の開発ネットワークのまま動くため、パッケージ導入や API ドキュメント参照、テスト実行が滞りません。外部 SaaS への書き込みは xMatrix のアプリ別承認レイヤーで保護されます。",
      },
      {
        question: "xMatrix を試すのに招待コードは必要ですか？",
        answer:
          "いいえ。xMatrix はオープンなセルフサーブ形式で、3 名まで・エージェント無制限の無料プランからすぐ始められます。",
      },
      {
        question: "xMatrix はコード専用ですか？ドキュメントや運用業務の更新にも使えますか？",
        answer:
          "両方に対応します。リポジトリでコードを出荷するだけでなく、リリース計画・リサーチ・採用・インシデント対応・日常運用の生きたページもエージェントが最新化し続けます。",
      },
    ],
  },
  "t3-code": {
    verifiedDate: "2026年11月22日",
    metaTitle: "T3 Code 代替 (2026)：T3 Code vs xMatrix",
    metaDescription:
      "T3 Code の代替ツールをお探しですか？固有のユーザー ID、共有チャンネル（GitHub Discussions #27974）、生きたプロジェクトページ（#15858）、Space シークレット、プロバイダー間引き継ぎ（#15846）を xMatrix で実現。",
    eyebrow: "T3 Code 代替 · T3 Code vs xMatrix",
    headline: "チームで使う T3 Code 代替：固有の ID、1 つのチャンネル、1 つの生きたページ",
    lead: "T3 Code は優れた無料の個人向けコーディングワークベンチですが、各環境が 1 アカウントに紐づき、共有の生きたプロジェクトページがなく、プロバイダークォータ切れで「Limited」のまま停止します。xMatrix はチームに共有チャンネル、生きたページ、Space シークレット、そして複数マシン横断の 35 種類のコーディングエージェントを提供します。",
    productCaption:
      "xMatrix の画面：所有マシン全体で 35 種類のコーディングエージェントが協業し、チーム全員の生きたページを最新化し続ける本物のマルチプレイヤーチャンネル。",
    painPoints: [
      {
        title: "本物のマルチプレイヤー ID も共有チームチャンネルもない",
        problem:
          "T3 Code は各環境を単一の T3 Connect アカウントに紐づけるため、ログ上の発言者は全員ただの「user」になり、ゲストリンクも 24 時間で失効して毎回ホストの承認が必要です。GitHub Discussions でのチーム対応要望（#27974、#12283、#27708）は未解決のままで、サードパーティフォークへ移るチームが出ています。",
        xmatrixAnswer:
          "xMatrix は最初から複数人＋複数エージェントの Space として設計されています。固有のユーザー ID、パブリック／プライベートチャンネル、執筆者付きのページ編集、依頼者への的確な通知を備えます。",
      },
      {
        title: "「Limited」で完全停止。プロバイダー間の自動クォータ引き継ぎがない",
        problem:
          "T3 Code で Claude や Codex が利用上限に達すると、リセットか手動切り替えまでスレッドが「Limited」で凍結します。GitHub Discussions での自動プロバイダーフェイルオーバー要望（#15846、#24453、#18949）は未実装であり、ラッパーのサブタスク消費による上限早期到達や誤った「Limited」表示も報告されています。",
        xmatrixAnswer:
          "xMatrix は登録ハーネス全体のプロバイダークォータ窓を監視し、上限に達したプロバイダー（例：Claude Code）から別の空きプロバイダー（例：Codex や Gemini）へ自動で作業を引き継いで前進を止めません。",
      },
      {
        title: "生きたプロジェクトページ、Space シークレット、運用コネクタがない",
        problem:
          "T3 Code はローカル差分やエミュレータに強い一方、共有プロジェクトメモリや生きたドキュメント（GitHub Discussions #15858）がなく、新規スレッドの既定は Full access、無料 T3 Connect トンネルも 3 台までで、運用系アプリの統制も範囲外です。",
        xmatrixAnswer:
          "xMatrix は完了した会話を生きたページへ昇華させ、35 種類のコーディングエージェントでチーム全体のマシンを台数制限なく接続でき、Space シークレットの安全な管理と Vercel・Cloudflare・Sentry・Gmail・Stripe など 35 の連携アプリ統制を提供します。",
      },
    ],
    comparisonRows: [
      {
        dimension: "マルチプレイヤーと帰属表示",
        xmatrix: "本格的なチーム Space、個人ごとの ID、公開／非公開チャンネル、執筆者付き編集",
        competitor: "単一ユーザー環境。24 時間ゲストリンク（ベータ）のみ、チーム ID なし",
      },
      {
        dimension: "プロバイダーがクォータ上限に達したとき",
        xmatrix: "未コミット変更を保ったまま別プロバイダーへ自動引き継ぎ",
        competitor: "Limited で一時停止。手動切替かリセット待ちのみ",
      },
      {
        dimension: "プロジェクト状況と生きたドキュメント",
        xmatrix: "エージェントが最新化し人と共同編集する生きたページ",
        competitor: "スレッド単位の履歴のみ。プロジェクトメモリや生きた文書なし（GitHub Discussions #15858）",
      },
      {
        dimension: "標準の安全性と運用ガバナンス",
        xmatrix: "35 アプリのアプリ別ポリシー + Space シークレット",
        competitor: "新規スレッドは既定で Full access。マシンローカル秘密情報、開発課題のみ",
      },
      {
        dimension: "対応エージェントとリモートマシン",
        xmatrix: "所有する macOS・Windows・Linux マシン全体で 35 種類のコーディングエージェント（+ --runtime）",
        competitor: "10 ハーネス + ACP。T3 Connect 無料枠は 3 台まで",
      },
    ],
    stayWhen: [
      "完全に 1 人で開発しており、内蔵差分レビュー・チェックポイント巻き戻し・ブラウザプレビュー・iOS/Android シミュレータ付きの無料ローカル IDE を求めている。",
      "1〜3 台のマシンでアカウントレスなローカル利用ができれば十分で、チームメイト・生きたドキュメント・コード以外のコネクタは不要。",
    ],
    switchWhen: [
      "2 名以上で明確な発言者・編集者の帰属と共有文脈を持ちながら、同じワークスペースでコーディングエージェントを使いたい。",
      "Codex や Gemini の枠が余っているのに Claude の 5 時間／週間上限でスレッドが「Limited」のまま止まるのにうんざりしている。",
      "何十本ものスレッドの成果を生きたページにまとめつつ、Vercel・Cloudflare・Linear・Sentry・Gmail も安全に連携したい。",
    ],
    migrationSteps: [
      {
        title: "既存のローカル CLI をそのまま使う（MCP 併用も可能）",
        detail:
          "T3 Code 用に導入済みのローカル Claude Code・Codex・Cursor・OpenCode・Grok・Antigravity CLI をそのまま xMatrix で利用できます。",
      },
      {
        title: "T3 Chat バンドルなしで 4 台以上のマシンを接続する",
        detail:
          "ノート PC・ビルドサーバー・自前サーバーを 1 つの Space へ直接登録し、余力のあるマシンとプロバイダーへ @auto で自動ルーティングさせます。",
      },
      {
        title: "プロジェクトごとに「生きたページ」を持たせる",
        detail:
          "新しいスレッドを開くたびに設計方針を説明し直すのをやめ、全ハーネスが共通で読むプロジェクトページに一度だけ記述します。",
      },
    ],
    faqs: [
      {
        question: "T3 Code が無料なのに、なぜ xMatrix Pro に課金する価値があるのですか？",
        answer:
          "1〜3 台のマシンで使う個人向け無料ワークベンチだけが目的なら T3 Code は素晴らしい選択です。チームが xMatrix を選ぶのは、本物のマルチプレイヤー Space、生きたプロジェクトページ、プロバイダー間の自動クォータ引き継ぎ、Space シークレット、35 の連携アプリ統制が必要だからです。",
      },
      {
        question: "Claude が上限に達したとき、xMatrix は自動で別プロバイダーへ切り替えますか？",
        answer:
          "はい。あるプロバイダーのクォータ窓が尽きると、単一ベンダーの複数アカウント規約違反ローテーションを行うのではなく、あなたが登録している別の空きハーネスへ自動的にルーティング・引き継ぎを行います。",
      },
      {
        question: "T3 Code と xMatrix を併用することもできますか？",
        answer:
          "はい。xMatrix はページの読み書きやチャンネル送信用の MCP サーバーを公開しており、同じローカルリポジトリをロックせずに併用できます。",
      },
    ],
  },
  herdr: {
    verifiedDate: "2026年11月22日",
    metaTitle: "herdr 代替 (2026)：herdr vs xMatrix",
    metaDescription:
      "herdr（herdr-core）の代替ツールを評価中ですか？内蔵認証、チーム権限、ウェイトリストなしで今すぐ使えるクロスデバイス連携、アプリ別承認、生きたページを xMatrix で。",
    eyebrow: "herdr 代替 · herdr vs xMatrix",
    headline: "認証・チーム承認・生きたページをデバイス横断で今すぐ使える herdr 代替ツール",
    lead: "herdr は人気 Rust 製 TUI マルチプレクサから herdr-core＋ネイティブアプリへと進化しましたが、破壊的なプロトコル変更や GUI ロックインへの Reddit 反発を招きつつ、複数ユーザー認証・承認・シークレット・本番クラウドリレーはまだ揃っていません。xMatrix は統制の効いた協業基盤を今すぐ提供します。",
    productCaption:
      "xMatrix の画面：無認証のプレビューソケットではなく、認証済み Space・Space シークレット・生きたページを備えたデスクトップ／Web／モバイル横断連携が今日から動きます。",
    painPoints: [
      {
        title: "認証、権限境界、承認フロー、シークレット管理が存在しない",
        problem:
          "herdr-core は明確に単一ユーザー向けローカルランタイムであり、ソケットに到達できる相手は事実上シェルアクセス権を得ます。ユーザーロール、操作承認、シークレット保管庫、定期・Webhook 自動化はいずれもありません。",
        xmatrixAnswer:
          "xMatrix はローカル実行の上に信頼境界を構築します。検証済みの人・エージェント ID、生値を出さずに注入する Space シークレット、アプリ別承認ポリシー、Norn 自動化を標準搭載しています。",
      },
      {
        title: "プロトコル変動、破壊的変更、TUI から GUI への転換に対する反発",
        problem:
          "herdr-core への書き直しで既存サードパーティクライアントが壊れ、v0.9.2 でペイングラフィックス API が削除されたほか、汎用 SSH TUI から専用クライアントへの移行に Reddit で反発が起きました。SSH stderr のペイン混入、macOS メインスレッド停止（os error 35）、systemd ユニット間の CLAUDE_CODE_* 環境変数リークも継続 Issue となっています。",
        xmatrixAnswer:
          "xMatrix はバージョン管理された Hub/CLI 互換契約と実行単位の明示的分離のもと、Web・デスクトップ・CLI・モバイルの一貫した体験を提供します。",
      },
      {
        title: "Herdr Cloud はまだウェイトリスト制で、ターミナルには生きたドキュメントが残らない",
        problem:
          "クロスデバイス暗号化リレー（Herdr Cloud）と公式モバイルアプリはウェイトリスト／開発中であり、仮に公開されても PTY マルチプレクサではあらゆる意思決定がターミナルのスクロールバックに埋もれます。",
        xmatrixAnswer:
          "macOS・Windows・Linux・Android・Web（iPhone・iPad 対応）間のクロスデバイス連携は今日すぐ機能し、完了した実行が生きたページを自動で最新化し続けます。",
      },
    ],
    comparisonRows: [
      {
        dimension: "ID とセキュリティ境界",
        xmatrix: "認証済み Space、メンバーロール、Space シークレット、アプリ別承認",
        competitor: "なし（ローカルソケットへのアクセス＝フルシェルアクセス）",
      },
      {
        dimension: "クロスデバイス連携とモバイル",
        xmatrix: "macOS・Windows・Linux・Android・Web（iPhone・iPad 対応）で今すぐ稼働",
        competitor: "現在は手動 SSH 構築。Herdr Cloud リレーはウェイトリスト",
      },
      {
        dimension: "作業成果の蓄積先",
        xmatrix: "エージェントが最新化する生きたページ + 検索可能なチャンネル",
        competitor: "永続 PTY スクロールバックペイン",
      },
      {
        dimension: "自動化と連携アプリ",
        xmatrix: "スケジュール＆イベント駆動 Norn プログラム + 35 の連携アプリ",
        competitor: "内蔵 cron、Webhook 自動化、アプリコネクタなし",
      },
      {
        dimension: "主な対象ユーザー",
        xmatrix: "複数エージェントと運用アプリを統括する個人開発者およびチーム",
        competitor: "PTY ランタイム上で独自構築したい単一ユーザー向けターミナル上級者",
      },
    ],
    stayWhen: [
      "SSH 越しにカスタム端末 UI をスクリプト制御するため、生の JSON-RPC / OpenRPC ソケットを持つ Apache-2.0 ローカル PTY デーモンそのものがほしい。",
      "完全に 1 人でターミナル完結の作業をしており、チーム共有・生きたページ・外部アプリ承認は一切不要。",
    ],
    switchWhen: [
      "Herdr Cloud のウェイトリストを待ったり SSH ProxyCommand のリークを調査したりせず、今すぐクロスデバイスのデスクトップ＆モバイル連携を使いたい。",
      "GitHub・Vercel・Cloudflare・本番サービスへエージェントが触れる前に、本格的な認証・Space シークレット・人間の承認を挟みたい。",
      "永続 PTY ペインを探し回る代わりに、プロジェクト状況を常に最新のページで把握したい。",
    ],
    migrationSteps: [
      {
        title: "既存ツールと並べて xMatrix CLI をインストールする",
        detail:
          "手動 SSH トンネル構築なしで、コマンド 1 つで macOS・Linux・Windows マシンを登録できます。",
      },
      {
        title: "コーディングハーネスを一度登録する",
        detail:
          "xmatrix agent add で Claude Code・Codex・Cursor・Gemini・OpenCode を追加します。既存の契約はそのままローカルに残ります。",
      },
      {
        title: "定常的な進捗把握を生きたページへ移す",
        detail:
          "進行中プロジェクトのページを作り、定期・イベント駆動ルーチンで自動最新化させます。",
      },
    ],
    faqs: [
      {
        question: "ブラウザやノート PC の蓋を閉じてもエージェント実行は続きますか？",
        answer:
          "はい。デスクトップ、Mac Studio、Linux VPS などスリープせずに稼働しているマシン上の実行はデーモン上で継続し、再接続時に Web・デスクトップ・モバイルへ結果が同期されます。",
      },
      {
        question: "ローカル PTY ソケットを公開する方式と比べて、xMatrix はどこが安全ですか？",
        answer:
          "xMatrix はサーバー側で Space 認証とメンバー権限を強制し、マシン登録と Space アクセスを分離し、xmatrix secret exec でシークレットをマスクしつつ、外部 SaaS 操作を Read only / Ask first で統制します。",
      },
      {
        question: "ターミナルから xMatrix を操作することもできますか？",
        answer:
          "はい。ネイティブ Rust 製 CLI（xmatrix）を使えば、人間もエージェントもシェルから直接ページの閲覧、メッセージ送信、実行診断、承認制コネクタ実行を行えます。",
      },
    ],
  },
  seedmux: {
    verifiedDate: "2026年11月22日",
    metaTitle: "Seedmux 代替 (2026)：Seedmux vs xMatrix",
    metaDescription:
      "Seedmux の代替ツールをお探しですか？macOS＋iPhone ロックイン、クローズドソース、スマホ起動の YOLO 既定設定を脱し、macOS・Windows・Linux・Android・iOS 対応の xMatrix へ。",
    eyebrow: "Seedmux 代替 · Seedmux vs xMatrix",
    headline: "クロス OS チーム・Android・安全なモバイル統制に対応した Seedmux 代替ツール",
    lead: "Seedmux は洗練された Ghostty + tmux 製 macOS 端末と iPhone コンパニオンを組み合わせていますが、クローズドソースで Mac 専用・単一ユーザー向けであり、スマホ起動セッションが既定で YOLO モードになります。xMatrix は macOS・Windows・Linux・Android・iOS を横断する複数マシン協業、チーム Space、生きたページを提供します。",
    productCaption:
      "xMatrix の画面：スマホ発の YOLO 既定設定ではなく承認制アプリ統制を備えたまま、macOS・Windows・Linux・Android・Web（iPhone・iPad 対応）で 1 つのワークスペースを共有します。",
    painPoints: [
      {
        title: "macOS＋iPhone ロックインにより Windows・Linux・Android が置き去りになる",
        problem:
          "Seedmux はノッチ通知に依存したネイティブ macOS アプリと（Seedmux Pro 向けの）iPhone コンパニオン専用です。Windows や Linux のネイティブデスクトップアプリも、Web ワークスペースも、Android アプリもありません。",
        xmatrixAnswer:
          "xMatrix は macOS・Windows・Linux・Android・Web（iPhone・iPad 対応）で動作し、あなたやチームメイトが使うあらゆるマシンとスマホが同じ Space に参加できます。",
      },
      {
        title: "単一ユーザー向け端末ペインと、モバイルでの YOLO デフォルト設定",
        problem:
          "Seedmux にはチームチャンネルも共有ロールも Space シークレットもなく、iPhone コンパニオンから開始したセッションは既定で YOLO 権限になります。また携帯回線や企業ファイアウォール越しのリレーでは承認遅延も起きやすくなります。",
        xmatrixAnswer:
          "xMatrix はモバイルでもデスクトップでも同じ明示的ガバナンスを維持します。アプリ別 Read only / Ask first / Read & write、マスク済み Space シークレット、チームメイトがレビュー・承認できる共有チャンネルを備えます。",
      },
      {
        title: "壊れやすい CLI 状態スクレイピングと、残らないプロジェクトドキュメント",
        problem:
          "tmux 経由でローカル CLI ペインをラップする方式のため、CLI のアップデートや認証トークン失効でペイン状態検知が止まることがあり、多ペイン同時実行は MacBook の RAM を圧迫し、成果もスクロールバックに消えていきます。",
        xmatrixAnswer:
          "xMatrix は明示的なライフサイクル状態を持つ構造化ハーネスアダプタを採用し、接続マシン全体へ作業を分散して、完了した成果を生きたページへ蓄積します。",
      },
    ],
    comparisonRows: [
      {
        dimension: "対応プラットフォーム",
        xmatrix: "macOS・Windows・Linux・Android・Web（iPhone・iPad 対応）",
        competitor: "macOS＋iPhone コンパニオンのみ（Linux ホストへは SSH/リレー経由）",
      },
      {
        dimension: "チームコラボレーション",
        xmatrix: "複数人＋複数エージェントチャンネルと共同編集の生きたページ",
        competitor: "単一ユーザー端末のみ。共有チームチャンネルやドキュメントなし",
      },
      {
        dimension: "モバイルの安全既定値",
        xmatrix: "Web・デスクトップと同一のアプリ別承認ポリシーと Space シークレット",
        competitor: "スマホ起動セッションは既定で YOLO モード",
      },
      {
        dimension: "ソースの透明性",
        xmatrix: "FSL-1.1-ALv2 でソース公開",
        competitor: "クローズドソースのバイナリ配布",
      },
      {
        dimension: "外部運用アプリ",
        xmatrix: "35 の連携アプリ（GitHub、Linear、Vercel、Cloudflare、Sentry、Gmail、Stripe など）",
        competitor: "端末の CLI コマンドのみ。SaaS コネクタ承認レイヤーなし",
      },
    ],
    stayWhen: [
      "Ghostty の描画、tmux ペイン分割、MacBook ノッチポップアップそのものを重視する個人 macOS＋iPhone ターミナル愛好家である。",
    ],
    switchWhen: [
      "Windows・Linux・Android を使っている、またはそれらを使うチームメイトと協業している。",
      "リモートセッションを既定で YOLO 権限にすることなく、スマホから安全に操作・承認したい。",
      "一時的な端末ペインではなく、意思決定と進捗を生きたページとして残したい。",
    ],
    migrationSteps: [
      {
        title: "既存の CLI ツールとサブスクリプションをそのまま使う",
        detail:
          "Mac と Linux ホストに xMatrix をインストールし、xmatrix agent add で 35 種類のコーディングエージェント（Claude Code・Codex・Grok・OpenCode・Kimi など）を追加します。",
      },
      {
        title: "独自リレーを建てずに Web・デスクトップ・モバイルを使う",
        detail:
          "任意のブラウザ（iPhone・iPad 対応）、デスクトップアプリ、Android 端末から進捗追跡と承認を行えます。",
      },
      {
        title: "ワーカー出力を 1 枚の生きたページに集約する",
        detail:
          "ワーカーペインのレシートを手動で巡回する代わりに、各エージェントがプロジェクトページの担当セクションを更新します。",
      },
    ],
    faqs: [
      {
        question: "xMatrix にも Seedmux のワーカーのような構造化されたタスクレシートはありますか？",
        answer:
          "はい。エージェントへ送られるすべてのプログラムリクエストは型付き応答（typed reply）で完了し、明示的なライフサイクル状態や更新内容がチャンネルとリンク先ページへ直接反映されます。",
      },
      {
        question: "MacBook と一緒に Linux サーバーも接続できますか？",
        answer:
          "はい。Linux・macOS・Windows マシンにネイティブの xMatrix デーモンを入れれば、すべてが Space 内の統合された Agents マトリクスに表示されます。",
      },
      {
        question: "xMatrix はオープンソースですか、それともクローズドソースですか？",
        answer:
          "クローズドソースの Seedmux と異なり、xMatrix は GitHub（LambdaLabsHQ/xmatrix）上で FSL-1.1-ALv2 ライセンスのもとソース公開されています。",
      },
    ],
  },
  "claude-code": {
    alsoKnownAs: "Claude Code Desktop・Cowork・Dispatch",
    verifiedDate: "2026年11月22日",
    metaTitle: "Claude Code 代替 (2026)：チームと生きたページを加える xMatrix",
    metaDescription:
      "Claude Code の周りに共有チャンネル、生きたページ、他 34 種類のコーディングエージェントを加えませんか？Claude Code を xMatrix 内で活かしつつ、5 時間上限時の自動クォータ引き継ぎも備えます。",
    eyebrow: "Claude Code 代替 · Claude Code vs xMatrix",
    headline: "Claude Code の代替？Claude Code はそのままに、チームメイト・他 34 種類のエージェント・生きたページを追加",
    lead: "Claude Code Desktop と Cowork は 1 つの Claude セッションとの個人ペアリングに優れていますが、チームメイトは蚊帳の外になり、文脈は個人セッションに閉じ込められ、2026年11月の厳格化された 5 時間・週間上限に達すると止まってしまいます。xMatrix は Claude Code を共有チャンネル、生きたページ、他 34 種類のコーディングエージェント、Space シークレットで包み込みます。",
    productCaption:
      "xMatrix の画面：手元の Claude Code CLI をそのまま動かし続けながら、チームメイトと他 34 種類のコーディングエージェントが同じチャンネルで協業し、生きたページを最新に保ちます。",
    painPoints: [
      {
        title: "1 対 1 の個人ペアリング向けで、チーム協業や共有生きたドキュメントがない",
        problem:
          "Claude Code Desktop は 1 人が 1 つのエージェントを逐次見守る設計です。Projects メモリは個人専用、Claude Tag も Slack Team/Enterprise 限定で、人間と複数ハーネスが共同維持する生きたページがありません。",
        xmatrixAnswer:
          "xMatrix は 1 段上の協調層を提供します。チームメイトと数十の並列エージェントが共有チャンネルで協業し、完了した実行が共有の生きたページを更新するため、端末の 1 行ずつではなく成果と意思決定を監督できます。",
      },
      {
        title: "共通の 5 時間・週間クォータ壁で作業が完全に止まる",
        problem:
          "Claude Code、Claude Desktop、Cowork が同じプラン枠を共有し、さらにバックグラウンドサブエージェントや /code-review がトークン消費を加速させるため（2026年11月には r/claude で 3 倍消費の報告が相次ぎました）、Pro や下位プランでは日中に上限へ達し、別プロバイダーへ逃がす手段がありません。",
        xmatrixAnswer:
          "xMatrix は Claude Code を捨てるのではなく強化します。Claude Code が 5 時間または週間の上限に達しても、未コミット変更を含む作業ツリーとページの文脈をそのまま Codex・Gemini・Cursor など別の登録エージェントへ引き継ぎ、作業を止めません。",
      },
      {
        title: "マシン横断の Space シークレットやマルチハーネス統制がない",
        problem:
          "Claude Code Desktop はローカル実行を Anthropic エコシステムに縛り、異種ハーネス共通の Space シークレット注入を持たず、Anthropic の地域制限により非対応地域では利用自体がブロックされます。",
        xmatrixAnswer:
          "xMatrix は macOS・Windows・Linux マシン群の 35 種類のコーディングエージェント（および --runtime による任意のカスタム CLI）を、共通の Space シークレットと 35 の連携アプリに対するアプリ別承認のもとで統合運用します。",
      },
    ],
    comparisonRows: [
      {
        dimension: "協業と共有メモリ",
        xmatrix: "複数人パブリック／プライベートチャンネル + 人とエージェントが共同編集する生きたページ",
        competitor: "単一ユーザーセッションと個人 Projects。Claude Tag は Slack 有料プラン限定",
      },
      {
        dimension: "対応コーディングエージェント",
        xmatrix: "35 種類のコーディングエージェント（Claude Code・Codex・Cursor・Gemini・Antigravity 等）+ --runtime",
        competitor: "Claude のみ",
      },
      {
        dimension: "Claude が利用上限に達したとき",
        xmatrix: "作業ツリーとページ文脈を別の利用可能なエージェントへ自動引き継ぎ",
        competitor: "5 時間／週間リセットまで停止、または従量課金 API キーへの切り替えが必要",
      },
      {
        dimension: "監督スタイル",
        xmatrix: "ページ・PR チェック・承認カードを見ながら数十の並列実行を管理",
        competitor: "1 セッションの差分ビューア・端末・確認プロンプトに張り付いてペアリング",
      },
      {
        dimension: "運用コネクタとシークレット",
        xmatrix: "Space シークレット + アプリ別ポリシー対応の 35 アプリ",
        competitor: "セッション単位の MCP ツール。Duet クラウド VM は米国限定リサーチウェイトリスト",
      },
    ],
    stayWhen: [
      "Claude しか使わず完全に 1 人で作業しており、Anthropic 契約に含まれるインライン差分ペアリングと内蔵クラウド VM だけで完結させたい。",
    ],
    switchWhen: [
      "Claude の 5 時間／週間上限のたびに半日を失うのに疲れており、Codex や Gemini にシームレスに引き継がせたい。",
      "チームメイトと複数ハーネスで同じチャンネル・生きたページ・Space シークレットを共有したい。",
      "多数の並列ワークストリームを監督しており、全ターミナルに張り付くのではなくプロジェクトページと例外カードで管理したい。",
    ],
    migrationSteps: [
      {
        title: "既存の Claude Code CLI はアンインストールせずそのまま残す",
        detail:
          "xMatrix は公式のローカル Claude Code CLI を既存ログインのまま直接駆動するため、失うものは何もありません。",
      },
      {
        title: "クォータ継続のために第 2 のハーネスを追加する",
        detail:
          "xmatrix agent add で Claude Code と並べて Codex・Gemini・Cursor・OpenCode を登録すれば、@auto が上限を自動で迂回します。",
      },
      {
        title: "ローカル CLAUDE.md の繰り返し文脈を生きたページへ移す",
        detail:
          "プロジェクト状況・決定事項・残タスクをページにまとめ、すべてのハーネスとチームメイトが同じ最新情報を共有できるようにします。",
      },
    ],
    faqs: [
      {
        question: "xMatrix を使うには Claude Code を手放す必要がありますか？",
        answer:
          "まったくありません。Claude Code は xMatrix の第一級ハーネスです。手元のマシンで Claude Code を使い続けながら、マルチプレイヤーチャンネル、生きたページ、上限時の Codex・Gemini 自動フェイルオーバーを追加できます。",
      },
      {
        question: "xMatrix で自分の個人 Claude サブスクリプションをチーム全員で使い回せますか？",
        answer:
          "いいえ。xMatrix は各ベンダーの利用規約を尊重しており、サブスクリプションの不正プールは推奨・提供していません。各マシンとユーザーはそれぞれ正規に認可されたハーネス契約または API キーを持ち込みます。",
      },
      {
        question: "xMatrix には Claude Cowork のようなクラウド VM が含まれていますか？",
        answer:
          "現時点では含まれていません。xMatrix はあなた自身が所有・管理する macOS・Windows・Linux のノート PC・デスクトップ・自前サーバーを接続して動作します。",
      },
    ],
  },
  linear: {
    alsoKnownAs: "Linear Coding Sessions & Loops",
    verifiedDate: "2026年11月22日",
    metaTitle: "Linear Agents 代替 (2026)：Linear vs xMatrix",
    metaDescription:
      "Linear Agents の代替ツールを比較中ですか？12 か月失効のプリペイドクレジット、クラウド専用チケット実行、Enterprise 限定監査ログを避け、ローカル実行・ライブチャンネル・生きたページの xMatrix へ。",
    eyebrow: "Linear Agents 代替 · Linear vs xMatrix",
    headline: "Linear Agents の代替：自分のマシンと既存契約で実行 — 失効クレジットなし、Linear と併用可能",
    lead: "Linear は卓越した課題管理ツールであり、Linear Agents は要件が明確な Issue をクラウドサンドボックスの PR に変えられます（20 分ごとに $0.25＋12 か月で失効する別建てプリペイド残高からのトークン課金）。課題管理は Linear に残したまま xMatrix と連携すれば、自分のマシン上で 35 種類のコーディングエージェントをライブチャンネルと生きたページで運用できます。",
    productCaption:
      "xMatrix の画面：Linear を連携したまま、サンドボックス従量課金や失効するプリペイド残高なしで、ローカルの Claude Code や Codex をライブチャンネルで動かせます。",
    painPoints: [
      {
        title: "12 か月で失効し返金不可の別建てプリペイドクレジット財布",
        problem:
          "Basic（$10/席）や Loops に必須の Business（$16/席）に加え、Linear Coding Sessions には別建ての USD プリペイド残高（最低 $10、12 か月で失効、返金不可）のチャージが必要で、トークン代に加えて 20 分ごとに $0.25 のサンドボックス料金がかかります。曖昧なチケットでリトライが続くとクレジットが急速に消えます。",
        xmatrixAnswer:
          "xMatrix はすでに契約している Claude Code・Codex・Cursor サブスクリプションを使って自分のマシン上でエージェントを実行するため、サンドボックスの時間課金も失効するプリペイド残高もありません。",
      },
      {
        title: "すべてがチケット前提。ライブな複数エージェントチャンネルもローカルマシン統括もない",
        problem:
          "Linear Agents は範囲が明確な Issue をクラウドサンドボックスで片付けるのには向いていますが、手元の MacBook・Linux ビルド機・Windows マシンにまたがるエージェント統括や、複数ハーネスを同時に舵取りするリアルタイム共有チャンネルはありません。",
        xmatrixAnswer:
          "xMatrix は人と複数のローカルハーネスがリアルタイムで協業するライブチャンネルを提供し、その結果を生きたページへ直接反映します。",
      },
      {
        title: "コード操作ごとの承認がなく、エージェント監査ログも薄い",
        problem:
          "Linear の監査ログは Enterprise プラン限定であり、個別エージェントの細かい操作までは記録されません。Cloudflare・Vercel・Gmail・Sentry・Stripe を横断するアプリ別承認ゲートもありません。",
        xmatrixAnswer:
          "xMatrix は全プランで会話・実行トレース、Space シークレット、さらに Linear 自身を含む 35 の連携アプリに対するアプリ別ポリシーを提供します。",
      },
    ],
    comparisonRows: [
      {
        dimension: "コーディングエージェントの実行場所",
        xmatrix: "自分の macOS・Windows・Linux マシン（ノート PC・デスクトップ・自前サーバー）",
        competitor: "Linear のクラウドサンドボックス（$0.25/20 分）または外部ベンダークラウド",
      },
      {
        dimension: "エージェント課金モデル",
        xmatrix: "35 種類のコーディングエージェントで既存契約持ち込み。Pro は人 1 席あたり月額 $10（年払い $8）",
        competitor: "席料金（$10〜$16/月）+ 別建てプリペイドクレジット（12 か月失効・返金不可）",
      },
      {
        dimension: "得意な仕事のタイプ",
        xmatrix: "ライブチャンネル・生きたページ・運用から始まる作業（Linear と直接連携）",
        competitor: "クラウド PR へ流せる明確にスコープ定義された Issue チケット",
      },
      {
        dimension: "ガバナンスと監査性",
        xmatrix: "全プランで 35 アプリ横断のアプリ別ポリシー + Space シークレット",
        competitor: "チーム単位のエージェント ON/OFF。監査ログは Enterprise 限定かつ操作粒度なし",
      },
      {
        dimension: "Linear と併用できるか？",
        xmatrix: "ネイティブ Linear コネクタで xMatrix エージェントが Linear Issue を読み書き可能",
        competitor: "Issue 中心。外部エージェントは Agent Interaction API で接続",
      },
    ],
    stayWhen: [
      "ワークフローが完全に「明確な単体チケット → PR」だけで完結しており、ローカルマシンのセットアップを一切したくない。",
      "すでに Linear Business で業務が完結しており、たまに Linear Issue 上でクラウド Loops を回す程度で十分。",
    ],
    switchWhen: [
      "20 分ごとのサンドボックス料金や失効プリペイド残高を気にせず、既存の Claude Code / Codex 契約を自分のハードウェアで活かしたい。",
      "チケットだけでなく、設計・リリース・運用のためのライブ複数エージェントチャンネルと生きたページが必要。",
      "Linear、GitHub、Vercel、Cloudflare、Sentry、Gmail を横断するアプリ別承認と Space シークレットを使いたい。",
    ],
    migrationSteps: [
      {
        title: "Linear は課題管理として残したまま xMatrix に接続する",
        detail:
          "Linear を捨て去る必要はありません。xMatrix に Linear アプリを連携すれば、ローカルエージェントが Issue を読み、PR を出し、ステータスを同期します。",
      },
      {
        title: "手元のマシンとハーネスを登録する",
        detail:
          "クラウドサンドボックス料金なしで、自分のワークステーション上の Claude Code・Codex・Cursor・Gemini を実行します。",
      },
      {
        title: "プロジェクトの最新情報を生きたページで維持する",
        detail:
          "各ワークストリームにページを紐づけ、チケットコメントの外側でも設計決定・リリース状況・ブロッカーを一目で読めるようにします。",
      },
    ],
    faqs: [
      {
        question: "xMatrix を使うために Linear をやめる必要はありますか？",
        answer:
          "いいえ。xMatrix にはネイティブの Linear コネクタがあるため、Issue 管理は Linear に残したまま、複数エージェント実行・生きたページ・承認制運用ワークフローを xMatrix で回せます。",
      },
      {
        question: "Linear の Coding Sessions で BYOK を使えば済むのでは？",
        answer:
          "BYOK を使っても、Linear Coding Sessions は失効するプリペイドクレジットから 20 分 $0.25 が課金されるクラウドサンドボックス専用であり、ローカルマシンの統括や Linear 以外の運用コネクタ制御はできません。",
      },
      {
        question: "xMatrix では Loops のような定期自動化に追加料金がかかりますか？",
        answer:
          "いいえ。スケジュールおよびイベント駆動の Norn ルーチンは xMatrix のページに標準内蔵されており、既存のプランクレジット内で使えます。上位 Business プランへのアップグレードは不要です。",
      },
    ],
  },
  notion: {
    alsoKnownAs: "Notion AI & External Agents",
    verifiedDate: "2026年11月22日",
    metaTitle: "Notion Custom Agents 代替 (2026)：Notion vs xMatrix",
    metaDescription:
      "Notion Custom Agents の代替ツールをお探しですか？月額 $20〜$24 の Business 壁、3 つのクレジット財布、作成者枯渇による途中停止、モバイル制限を解消する xMatrix の生きたページ。",
    eyebrow: "Notion Custom Agents 代替 · Notion vs xMatrix",
    headline: "Notion Custom Agents の代替：コード出荷と同時に更新される生きたページ — 3 つのクレジット財布は不要",
    lead: "Notion Custom Agents は $20〜$24/席の Business ペイウォールと複雑な 3 種類のクレジット財布の奥にあり、共有エージェントを使うと作成者個人の Select クレジットを消費して途中で停止します。xMatrix は 35 種類のコーディングエージェントが実リポジトリでコードを出荷するたびに生きたページを自動更新します — クレジット財布は不要です。",
    productCaption:
      "xMatrix の画面：エージェントが実際のリポジトリで動き、チャンネルでチームと話し、生きたページを最新化。Space 共通プールとフルモバイル対応でストレスなく使えます。",
    painPoints: [
      {
        title: "3 種類のクレジット財布と、作成者の残高枯渇による途中停止",
        problem:
          "Notion は AI 利用枠を個人の Standard クレジット（1,500/月）、個人の Select クレジット（500/月、Custom Agents に必須）、管理者購入の Workspace Notion Credits（$10/1,000）の 3 つに分割しています。個人残高はプールも繰越もできず、チームメイトが共有エージェントを動かすと既定で作成者個人の Select 枠を消費し、0 になった瞬間にタスク途中で止まります。",
        xmatrixAnswer:
          "xMatrix Pro は人 1 席あたり定額月額 $10（年払い $8/月）で、1 席あたり 5,000 エージェントクレジットを Space 全体でプール共有。50% の猶予クッション付きで LLM トークン転売はゼロ、人間の編集は常に無料です。",
      },
      {
        title: "ローカルマシン実行、クロスデバイス連携、リアルタイムエージェントチャンネルがない",
        problem:
          "Notion は文書を手作業の場として扱い、コーディングは外部クラウド API（アルファ版）へ委譲します。手元のノート PC やビルドサーバーで Claude Code や Codex を直接動かせず、Space シークレットも複数人＋複数エージェントのライブチャンネルもありません。",
        xmatrixAnswer:
          "xMatrix ではチャンネルで話すだけで macOS・Windows・Linux 上の実リポジトリでエージェントが動き、生きたページが開発作業の自然な副産物として自動更新されます。",
      },
      {
        title: "モバイルでは共有 Custom Agents の作成はおろか実行すらできない",
        problem:
          "Notion モバイルアプリでは Custom Agents を作成できず、実行できるのも自分が個人所有するエージェントだけに限られるため、外出先のチームメイトは共有エージェントを使えません。",
        xmatrixAnswer:
          "xMatrix ではすべてのメンバーが Web（iPhone・iPad 対応）・デスクトップ・Android からページ閲覧、認可済み Space エージェントの呼び出し、外部コネクタ承認を制限なく行えます。",
      },
    ],
    comparisonRows: [
      {
        dimension: "料金とクレジット体系",
        xmatrix: "Free（累計 500 書き込み）+ Pro 月額 $10/席（年払い $8）。Space 全体で共有する単一枠",
        competitor: "Business 月額 $20〜$24/席 + 3 種類の別財布（Standard、Select、Workspace $10/1,000）",
      },
      {
        dimension: "エージェントの実行場所",
        xmatrix: "自分の macOS・Windows・Linux マシン上で 35 種類のコーディングエージェントを直接実行",
        competitor: "Notion クラウドブラウザ／VM。コーディングは外部ベンダークラウドへ委譲",
      },
      {
        dimension: "ドキュメントの鮮度維持",
        xmatrix: "実作業を行うコーディングエージェントが出荷と同時にページを更新（提案モード・帰属表示あり）",
        competitor: "人間がエージェント／トリガーを呼んでブロック編集（提案モード・帰属表示あり）",
      },
      {
        dimension: "モバイルでのチーム利用",
        xmatrix: "全メンバーがチャンネル・ページ・エージェント起動・承認をフル利用可能",
        competitor: "モバイルで Custom Agents を作成不可。チーム共有エージェントも実行不可",
      },
      {
        dimension: "シークレットと開発連携",
        xmatrix: "Space シークレット保管庫 + 35 の連携アプリ（Notion 自身も含む）",
        competitor: "CLI 実行向けの Space 単位シークレット保管庫なし",
      },
    ],
    stayWhen: [
      "非エンジニア部門を含め、リレーショナル Notion データベース、CRM テーブル、リッチな文書フォーマット運用が会社の中核になっている。",
    ],
    switchWhen: [
      "Standard・Select・Workspace の 3 種類のクレジット管理や、作成者 1 人の個人枠枯渇で共有エージェントが止まるトラブルから解放されたい。",
      "現実からズレていく Wiki ではなく、実リポジトリで動くコーディングエージェントが自動でプロジェクトページを最新化する仕組みがほしい。",
      "エンジニアがモバイルからも共有エージェント・Space シークレット・承認制デプロイ／運用コネクタを使えるようにしたい。",
    ],
    migrationSteps: [
      {
        title: "一夜で全移行せず、まず Notion を連携する",
        detail:
          "xMatrix にはネイティブの Notion コネクタがあるため、既存の Notion 仕様書を参照しながら生きた開発ステータスだけを xMatrix ページで運用できます。",
      },
      {
        title: "変化の激しいプロジェクト情報から xMatrix ページへ移す",
        detail:
          "Notion で最も早く陳腐化しやすいリリーストラッキング、設計判断、インシデント手順書から始めましょう。",
      },
      {
        title: "スケジュール・イベント駆動の Norn ルーチンを埋め込む",
        detail:
          "各ページ内にルーチンを直接組み込み、Notion Select クレジットを消費せずに GitHub や Sentry・定期実行でページを最新化します。",
      },
    ],
    faqs: [
      {
        question: "既存の Notion ワークスペースと xMatrix を連携できますか？",
        answer:
          "はい。xMatrix には Read only / Ask first / Read & write を設定できるネイティブ Notion コネクタが組み込まれています。",
      },
      {
        question: "自分が設定したエージェントをチームメイトが使うと追加課金されますか？",
        answer:
          "いいえ。xMatrix Pro では 1 人席あたり月 5,000 エージェントクレジットが Space 全体でプールされるため、作成者個人のクレジット財布がボトルネックになることはありません。",
      },
      {
        question: "同じ xMatrix ページを人間とエージェントが同時に編集するとどうなりますか？",
        answer:
          "常に人間が優先されます。エージェントが更新しようとしている段落にあなたが入力すると、エージェントは待機してあなたの記述を引き継ぐため、書いた文章が上書きされることはありません。",
      },
    ],
  },
  "slack-code": {
    alsoKnownAs: "Slack Code API",
    verifiedDate: "2026年11月22日",
    metaTitle: "Slack Code 代替 (2026)：15件API制限のない xMatrix",
    metaDescription:
      "Slack Code の代替ツールをお探しですか？非 Marketplace アプリに対する 1 req/分・15 件履歴制限、Free の 90 日制限、エージェント実行基盤不在を解決する xMatrix。",
    eyebrow: "Slack Code 代替 · Slack Code vs xMatrix",
    headline: "Slack Code の代替：エージェントは手元のマシンで、決定は生きたページへ — Slack と併用可能",
    lead: "Slack Code API は Slack 内にタスクチャンネルと差分プレビューを追加しますが、Slack 本体はあくまでチャット UI であり、エージェント実行基盤も生きたドキュメントもなく、非 Marketplace アプリには厳しい API 制限（履歴エンドポイント 1 リクエスト/分・最大 15 件）が課されています。Slack コネクタで Slack と連携したまま、自分のマシン上で 35 種類のコーディングエージェントを動かし、決定事項を生きたページに残せます。",
    productCaption:
      "xMatrix の画面：15 件 API 制限のないフル文脈アクセスを備え、自分のマシンと生きたページに支えられたネイティブな複数人＋複数エージェントチャンネル。",
    painPoints: [
      {
        title: "厳しい Slack API 制限がカスタムコーディングエージェントから文脈を奪う",
        problem:
          "Slack は非 Marketplace アプリの conversations.history と conversations.replies を 1 分あたり 1 リクエスト・1 リクエスト最大 15 件へ厳格化し、カスタムエージェントの文脈取得を大幅に制限して開発者から AI 囲い込みとの反発を招きました。さらに Free ワークスペースでは 90 日で履歴が消えます。",
        xmatrixAnswer:
          "xMatrix はエージェント前提で設計されているため、チャンネル全履歴の参照やページのアウトライン／セクション単位の読み込みを標準提供し、自分の Space に 15 件制限のような人工的な壁はありません。",
      },
      {
        title: "Slack はチャット UI に過ぎず、実行基盤・マシン間ルーティング・Space シークレットがない",
        problem:
          "Slack Code は差分やパートナーエージェントの進捗を表示できても、パートナーエージェントを別途契約するか、マシンランナー・デーモン・クォータ引き継ぎ・シークレット注入を自前で構築・運用する必要があります。",
        xmatrixAnswer:
          "xMatrix は実行協調スタック一式を標準提供します。macOS・Windows・Linux マシンを一度登録すれば、Claude Code・Codex・Cursor・Gemini 横断のルーティングとクリーンな Space シークレット注入が即座に使えます。",
      },
      {
        title: "ナレッジが流れ去る Slack チャンネルに埋もれて死ぬ",
        problem:
          "タスクチャンネルを作っても Slack には生きたプロジェクトドキュメント層がないため、数百件のメッセージの下に意思決定が沈み、新しいメンバーやエージェントは毎回「今も有効な決定」を推測する羽目になります。",
        xmatrixAnswer:
          "xMatrix の各チャンネルは生きたページと直結しており、エージェントが現在状態をその場で書き換えるため、1 ページ読むだけでプロジェクトの現在地がわかります。",
      },
    ],
    comparisonRows: [
      {
        dimension: "エージェントの文脈取得と API 制限",
        xmatrix: "ネイティブな全履歴チャンネル読み取り + 構造化ページのアウトライン／セクション読み取り",
        competitor: "非 Marketplace アプリの履歴／返信は 1 req/分・15 件上限。Free は 90 日制限",
      },
      {
        dimension: "実行ランタイム",
        xmatrix: "35 種類のコーディングエージェント（+ --runtime）に対応する内蔵クロスデバイスデーモン",
        competitor: "チャット UI のみ。別途パートナーエージェント契約か自前ホスティングが必要",
      },
      {
        dimension: "プロジェクトの最新状態",
        xmatrix: "作業完了に合わせてエージェントが更新する生きたページ",
        competitor: "流れ去るチャット履歴とアーカイブされたタスクチャンネル",
      },
      {
        dimension: "統制された連携アプリとシークレット",
        xmatrix: "Space シークレット + アプリ別ポリシー付き 35 の連携アプリ",
        competitor: "内蔵のエージェントシークレット保管庫やアプリ横断の実行ガバナンスなし",
      },
      {
        dimension: "Slack と併用できるか？",
        xmatrix: "ネイティブ Slack コネクタで承認付き読み書き・投稿が可能",
        competitor: "Slack 内部に完全閉鎖",
      },
    ],
    stayWhen: [
      "会社全体が Slack から絶対に離れられない方針で、有料の Marketplace パートナーエージェントが既存 Slack スレッドに差分を貼るだけで十分である。",
    ],
    switchWhen: [
      "Slack の 1 req/分・15 件の履歴 API 制限がカスタムエージェントワークフローを壊している。",
      "自前の接着インフラを作らずに、Claude Code・Codex・Cursor を複数マシンで動かせる即戦力ランナーがほしい。",
      "Slack のスクロールバックに消えるのではなく、意思決定を生きたページへ蓄積したい。",
    ],
    migrationSteps: [
      {
        title: "全社連絡は Slack に残し、xMatrix へ接続する",
        detail:
          "xMatrix のネイティブ Slack コネクタを Ask first または Read only で接続すれば、非エンジニアとの接点を切らずに開発実務を構造化できます。",
      },
      {
        title: "マルチエージェント開発チャンネルを xMatrix へ移す",
        detail:
          "マシンを登録し、フル文脈が使える xMatrix チャンネル上で Claude Code・Codex・Cursor を直接動かします。",
      },
      {
        title: "Slack のピン留めメッセージを生きたページへ昇格させる",
        detail:
          "古びたピン留めやブックマークを、エージェントが自動で最新化し続けるページに置き換えます。",
      },
    ],
    faqs: [
      {
        question: "xMatrix から既存の Slack ワークスペースへ投稿・連携できますか？",
        answer:
          "はい。xMatrix にはアプリ別の Read only / Ask first / Read & write を設定できるネイティブ Slack コネクタが含まれています。",
      },
      {
        question: "xMatrix では自分のエージェントが読めるチャンネル履歴に制限がありますか？",
        answer:
          "いいえ。エージェントは会話履歴とリンクされた生きたページを直接読めるため、非 Marketplace 向けの 15 件 API 壁のような制限はありません。",
      },
      {
        question: "Slack＋パートナーコーディングエージェントと比べて xMatrix の料金はどうですか？",
        answer:
          "Slack 席料にパートナーエージェント契約を積み上げる代わりに、xMatrix Pro は人 1 席あたり月額 $10（年払い $8/月）で、既存の CLI サブスクリプションを使ったエージェントを無制限に動かせます。",
      },
    ],
  },
  "nowledge-mem": {
    verifiedDate: "2026年11月22日",
    metaTitle: "Nowledge Mem 代替 (2026)：Nowledge Mem vs xMatrix",
    metaDescription:
      "Nowledge Mem の代替ツールを比較中ですか？チャットから記憶の断片を推測抽出するだけでなく、複数マシンでコーディングエージェントを実行し公式な生きたページを最新化する xMatrix。",
    eyebrow: "Nowledge Mem 代替 · Nowledge Mem vs xMatrix",
    headline: "Nowledge Mem の代替：実作業を行うエージェント自身が書き残すチームプロジェクト記憶",
    lead: "Nowledge Mem は AI ツール横断の巧みなローカルグラフ／ベクトル記憶層を作りますが、あくまで受動的なメモリ保管庫であり、過去チャットから事実を推測するだけでコーディングエージェント実行も外部ツール統制もできず、Team ワークスペースもプライベートベータのままです。xMatrix では作業を行う実行自身が公式な生きたページを書き、チーム全員で今日から共有できます。",
    productCaption:
      "xMatrix の画面：過去チャットから記憶を受動推測するのではなく、実際に仕事を出荷するコーディングエージェント自身がチーム全体の生きたプロジェクトページを正確に保ちます。",
    painPoints: [
      {
        title: "推測で抽出した記憶断片か、作業主体が更新する公式プロジェクトページか",
        problem:
          "Nowledge Mem はチャットを裏で観察し、30 日減衰や矛盾キューを伴う Trace → Unit → Crystal の記憶グラフを推定構築します。PR マージやデプロイで開発の事実が変わったとき、確率的な記憶抽出は公式記録からどうしてもズレが生じます。",
        xmatrixAnswer:
          "xMatrix では、PR をマージしたり検証を完了したまさにそのエージェント実行が、プロジェクトの生きたページをその場で書き換えます。提案モード、段落ごとの帰属表示、リビジョン履歴を備え、人もエージェントも同じ公式記録を読みます。",
      },
      {
        title: "エージェント統括、チームチャンネル、複数マシン実行がない",
        problem:
          "Nowledge Mem はコーディングエージェントを起動せず、共有チャンネルで複数メンバーを調整することも、マシン間で作業をルーティングすることもできません。別途ランナー、トンネル、MCP 設定を継ぎ接ぎする必要があります。",
        xmatrixAnswer:
          "xMatrix は協調レイヤー全体を一つのプロダクトに統合しています。共有チャンネル、35 種類のコーディングエージェントを横断する複数マシンルーティング、アウトライン／セクション単位の段階的ページ読み込み、生きたページが最初から揃っています。",
      },
      {
        title: "プライベートベータのままのチーム同期と、運用ガバナンスの欠如",
        problem:
          "Nowledge Mem Team は依然プライベートベータで、ローカル構成には macOS 15+ と手動の MCP／プロキシ配線が必要であり、本番ツール向けの Space シークレットやアプリ別承認ゲートもありません。",
        xmatrixAnswer:
          "xMatrix の Space は macOS・Windows・Linux・Android・Web（iPhone・iPad 対応）で今すぐセルフサーブ利用でき、Space シークレットと 35 の連携アプリに対するアプリ別ポリシーを備えます。",
      },
    ],
    comparisonRows: [
      {
        dimension: "中核の役割",
        xmatrix: "共有チャンネルでマルチエージェント作業を実行し、生きたページを最新化",
        competitor: "ツール横断の会話記憶を抽出・索引化・検索",
      },
      {
        dimension: "唯一の正解ソース（Source of Truth）",
        xmatrix: "稼働中の実行が直接書き換える公式な生きた Markdown ページ",
        competitor: "30 日減衰のある推定グラフ／ベクトル Crystal（LLM Wiki は派生ビュー）",
      },
      {
        dimension: "チーム利用の提供状況",
        xmatrix: "Free（累計 500 書き込み）・Pro チーム Space を今すぐセルフサーブで利用可能",
        competitor: "個人ローカルアプリ GA、Cloud パブリックベータ、Team ワークスペースはプライベートベータ",
      },
      {
        dimension: "エージェント実行",
        xmatrix: "自分のマシン横断で 35 種類のコーディングエージェント（+ --runtime）を起動・ルーティング",
        competitor: "コーディングエージェントの実行やルーティングは非対応",
      },
      {
        dimension: "シークレットと外部アプリ",
        xmatrix: "Space シークレット + アプリ別ポリシー付き 35 の連携アプリ",
        competitor: "Team にホスト型 Slack 接続あり。運用コネクタ承認基盤なし",
      },
    ],
    stayWhen: [
      "コード実行のやり方は変えず、Web 版 ChatGPT・Claude Web・Cursor 横断の個人用オフライン記憶グラフだけを作りたい。",
    ],
    switchWhen: [
      "過去ログから事実を推測するバックグラウンド抽出器ではなく、実作業を行うエージェント自身が 1 つの公式プロジェクトページを維持してほしい。",
      "プライベートベータを待たず、複数マシンでのエージェント実行と 35 の連携アプリ統制を備えたチーム Space を今日から使いたい。",
      "macOS・Windows・Linux・Android・Web 間で手動のローカルプロキシ／トンネル配線をなくしたい。",
    ],
    migrationSteps: [
      {
        title: "永続的な知見を生きた xMatrix ページへ昇格させる",
        detail:
          "重要な意思決定や設計メモ（OKF / Markdown エクスポートを含む）をプロジェクト別の xMatrix ページへ整理します。",
      },
      {
        title: "コーディングハーネスを一度接続する",
        detail:
          "Claude Code・Codex・Cursor・Gemini を xMatrix に登録すれば、各実行が必要なページアウトライン／セクションだけを読み、更新を書き戻します。",
      },
      {
        title: "Norn ルーチンでページの鮮度を定期維持する",
        detail:
          "待機チャットログにバックグラウンド LLM 抽出トークンを費やす代わりに、メトリクスやリリースノート、ブロッカーを自動で最新に保ちます。",
      },
    ],
    faqs: [
      {
        question: "ベクトルデータベースなしで、エージェントが文脈を読みすぎるのをどう防いでいますか？",
        answer:
          "xMatrix は段階的読み込み（プログレッシブリーディング）に対応しています。エージェントは Space のページツリーと要約を一覧し、ページのアウトラインとセクションサイズを確認して必要なセクションだけを読み、そのセクションだけを書き換えます。",
      },
      {
        question: "Nowledge Mem と xMatrix を併用することはできますか？",
        answer:
          "はい。普段の Web チャット用の個人メモリとして Nowledge Mem を使いつつ、共有プロジェクトの公式状態・エージェント統括・チーム承認は xMatrix で管理する併用も可能です。",
      },
      {
        question: "エージェントが xMatrix ページに誤った内容を書いてしまったらどうなりますか？",
        answer:
          "すべてのページに完全なリビジョン履歴と人間優先の共同編集があるため、あなたが該当行を修正すれば直ちに全エージェントが訂正後の内容を引き継ぎます。",
      },
    ],
  },
  everos: {
    alsoKnownAs: "EverMind / EverMemOS",
    verifiedDate: "2026年11月22日",
    metaTitle: "EverOS (EverMemOS) 代替 (2026)：EverOS vs xMatrix",
    metaDescription:
      "EverOS・EverMemOS の代替ツールをお探しですか？単一マシン SQLite ロック、裏で回り続ける抽出 LLM 課金、チーム同期不在を超え、xMatrix のチャンネルと生きたページへ。",
    eyebrow: "EverOS（EverMemOS）代替 · EverOS vs xMatrix",
    headline: "EverOS の代替：実作業を行うエージェント自身が書き残す複数マシン対応プロジェクト記憶",
    lead: "EverOS（EverMemOS）は Markdown ファイルとローカル SQLite・LanceDB インデックスを組み合わせますが、オープンソース v1 は同一ディレクトリでの 2 つ目のサービス起動を明示的に拒否し、マルチテナントと同期をスコープ外としており、裏で継続的な抽出 LLM トークンも消費します。xMatrix はチーム向けに 35 種類のコーディングエージェントによるリアルタイムな複数マシン実行と公式な生きたページを提供します。",
    productCaption:
      "xMatrix の画面：単一ディレクトリロックも裏の抽出トークン消費もなし。稼働中のコーディングエージェントが複数マシン横断でリアルタイムに Markdown ページを更新します。",
    painPoints: [
      {
        title: "同期なし・マルチテナントなしを明記した単一マシン設計の壁",
        problem:
          "EverOS v1 は単一ローカルプロセス前提で、同じディレクトリへの 2 つ目のサービス起動を拒否し、マルチテナントや分散同期を明示的にスコープ外としています。複数のコーディングツールからローカルの Markdown/SQLite ディレクトリを共有するとロック競合が起きます。",
        xmatrixAnswer:
          "xMatrix はすべてのチームメイトと登録済み macOS・Windows・Linux マシン間でページとチャンネルをリアルタイム同期し、ローカル SQLite のロック競合とは無縁です。",
      },
      {
        title: "常時発生するバックグラウンド LLM トークン負荷とローカル索引負荷",
        problem:
          "ローカルの LanceDB ベクトル索引に加え、エピソード抽出・矛盾解消・プロファイル統合のための LLM 呼び出しが継続的に走るため単一マシンの RAM を圧迫し、予測しにくい API 請求が発生します。しかもマルチユーザー EverMemBench の精度は 66.67% まで低下します。",
        xmatrixAnswer:
          "xMatrix は過去のログから出来事を推測するバックグラウンド抽出ループを回しません。タスクを完了したエージェント実行自身が該当ページセクションを直接更新します。",
      },
      {
        title: "メモリ保管庫だけではコーディングエージェントの実行・ルーティング・統制はできない",
        problem:
          "EverOS はメモリバックエンドであり（v1.7.1 では Foresight 予測機能も削除）、複数マシンでのコーディングエージェント起動や、Vercel・Cloudflare・Gmail・Stripe 操作前の人間承認は担えません。",
        xmatrixAnswer:
          "xMatrix は 35 種類のコーディングエージェントの実行、Space シークレット、35 の連携アプリに対するアプリ別承認、生きたページを 1 つのワークスペースに統合します。",
      },
    ],
    comparisonRows: [
      {
        dimension: "複数マシン・チーム同期",
        xmatrix: "macOS・Windows・Linux・Android・Web を横断するリアルタイム複数人・複数マシン Space",
        competitor: "オープンソース v1 は厳格な単一マシン専用。マルチテナントと同期はスコープ外",
      },
      {
        dimension: "ナレッジの最新化方法",
        xmatrix: "実作業を行うエージェント実行が公式な Markdown ページを直接書き換え",
        competitor: "SQLite + LanceDB 索引へのバックグラウンド LLM 抽出（追加トークン消費）",
      },
      {
        dimension: "エージェント実行とルーティング",
        xmatrix: "自分のマシン横断で 35 種類のコーディングエージェント（+ --runtime）を起動・ルーティング",
        competitor: "メモリ層のみ。エージェント群の実行や統括は非対応",
      },
      {
        dimension: "同時編集",
        xmatrix: "提案モード・帰属表示・人間編集優先を備えたライブ共同編集ページ",
        competitor: "ローカルディレクトリロック。複数ツールの同時書き込みで競合が発生",
      },
      {
        dimension: "ガバナンスと連携アプリ",
        xmatrix: "Space シークレット + アプリ別ポリシー付き 35 の連携アプリ",
        competitor: "なし",
      },
    ],
    stayWhen: [
      "会話メモリベンチマーク（LoCoMo / LongMemEval）を研究している、または単一マシンの Python/CLI スタックに Apache-2.0 のローカルメモリエンジンを組み込みたい。",
    ],
    switchWhen: [
      "複数マシンやチームメイトと仕事をしており、単一ディレクトリ v1 ロックの制約内に収まらない。",
      "バックグラウンド LLM 抽出コストを払い続けるのではなく、実作業を行う実行が公式な Markdown ページを維持する形にしたい。",
      "永続プロジェクト知識に加えて、35 種類のコーディングエージェントの本格的な実行と 35 の連携アプリ統制も必要。",
    ],
    migrationSteps: [
      {
        title: "既存の Markdown ファイルを xMatrix ページへ持ち込む",
        detail:
          "EverOS も Markdown を一次データとしているため、整理済みのプロジェクトメモをそのまま xMatrix ページへ移行できます。",
      },
      {
        title: "すべてのマシンを 1 つの Space に接続する",
        detail:
          "ノート PC とサーバーに xMatrix CLI を入れれば、ローカル SQLite のロックエラーなしで全ハーネスが同じ生きたページを共有します。",
      },
      {
        title: "稼働中の実行に各セクションを保守させる",
        detail:
          "バックグラウンド抽出パイプラインを廃止し、コードのマージや調査完了のたびにエージェントが担当セクションを直接更新する運用へ切り替えます。",
      },
    ],
    faqs: [
      {
        question: "xMatrix のページも EverOS のようにプレーンな Markdown ですか？",
        answer:
          "はい。ページはセクション単位の読み書き、リビジョン履歴、人とエージェントのリアルタイム共同編集に対応した構造化 Markdown ドキュメントです。",
      },
      {
        question: "xMatrix はバックグラウンドの記憶統合で追加の LLM トークンを消費しますか？",
        answer:
          "いいえ。作業を行ったエージェント自身がタスク完了の一環としてページを更新するため、全チャットログを常時解析する別パイプラインを回す必要がありません。",
      },
      {
        question: "マルチユーザー協業では EverOS と比べてどう違いますか？",
        answer:
          "xMatrix は初日から複数人＋複数エージェントの Space 前提で設計されており、執筆者帰属付きの編集、ライブチャンネル、単一マシンロックのない同期を備えています。",
      },
    ],
  },
  youmind: {
    verifiedDate: "2026年11月22日",
    metaTitle: "YouMind 代替 (2026)：YouMind vs xMatrix",
    metaDescription:
      "YouMind の代替ツールを比較中ですか？月額 $20〜$200 の個人クレジット課金や Android・チーム非対応から離れ、月額 $10/席の共有コーディングチャンネル・ローカルリポジトリ実行・生きたページの xMatrix へ。",
    eyebrow: "YouMind 代替 · YouMind vs xMatrix",
    headline: "チーム開発エージェント・Android・実リポジトリに対応した YouMind 代替ツール",
    lead: "YouMind は動画・ポッドキャスト・Web 調査をスライドや記事へまとめる洗練された個人向けクリエイションスタジオ（月額 $20〜$200 のクレジット制）ですが、ネイティブなチーム協業も Android アプリもなく、ローカルコーディングエージェントを実行する代わりに GitHub/Linear の文脈を橋渡しするだけです。xMatrix は実コード・リサーチ・運用を 1 つのマルチプレイヤー Space で統括します。",
    productCaption:
      "xMatrix の画面：リサーチ、仕様書、複数エージェントによるソフトウェア出荷を、デスクトップ・Web・Android・iOS 共通のマルチプレイヤー Space で一元管理します。",
    painPoints: [
      {
        title: "個人向けクリエイティブスタジオ設計で、リアルタイムチームチャンネルも権限統制もない",
        problem:
          "YouMind は個人のリサーチボードを中心に作られており、マルチプレイヤーワークスペースではありません。共同出荷に不可欠なリアルタイム共有チャンネル、ロール別承認ポリシー、Space シークレットが欠けています。",
        xmatrixAnswer:
          "xMatrix はチームメイトとエージェントを共有のパブリック／プライベートチャンネルに集め、生きたページとアプリ別の Read only / Ask first / Read & write ガバナンスで支えます。",
      },
      {
        title: "ローカルコーディングエージェント実行基盤ではなく、月額 $40〜$200 の高額クレジット層",
        problem:
          "YouMind は仕様下書きのために GitHub や Linear を接続できますが、ローカルリポジトリやビルドマシン上で Claude Code・Codex・Cursor を統括することはできません。重いマルチモーダル利用では Starter（$20/2万クレジット）や Pro（$40/4万クレジット）をすぐ使い切り、デスクトップエージェント機能は $100〜$200 の Max プラン限定です。",
        xmatrixAnswer:
          "xMatrix は既存サブスクリプションを使って自分のマシン上で本物のコーディングハーネスを動かしつつ、リサーチ・ドキュメント・運用までまとめて Pro 月額 $10/人席で提供します。",
      },
      {
        title: "Android アプリがなく、デバイス横断の開発ワークフローが分断される",
        problem:
          "YouMind は iOS と Chrome 拡張機能のみで公式 Android アプリがなく、Android を使う開発者は離席中に実行を監視・指示できません。",
        xmatrixAnswer:
          "xMatrix は macOS・Windows・Linux・Android・Web（iPhone・iPad 対応）で動作し、調査・仕様・PR・リリースを 1 つの生きたページに統合します。",
      },
    ],
    comparisonRows: [
      {
        dimension: "主な用途",
        xmatrix: "生きたページを中心に調整する、マルチプレイヤーのコーディング・リサーチ・運用",
        competitor: "個人向けのマルチメディア調査・コンテンツ制作ボード",
      },
      {
        dimension: "ローカルコード実行",
        xmatrix: "実ローカルリポジトリ上で 35 種類のコーディングエージェント（+ --runtime）を直接実行",
        competitor: "GitHub/Linear 文脈の橋渡し。デスクトップエージェントは $100〜$200 の Max 限定",
      },
      {
        dimension: "料金",
        xmatrix: "Free（累計 500 書き込み）+ Pro 月額 $10/人席（年払い $8）。既存契約持ち込み",
        competitor: "Starter $20 / Pro $40 / Max $100〜$200 / 月（従量クレジット制）",
      },
      {
        dimension: "チームコラボレーション",
        xmatrix: "複数人＋複数エージェントチャンネル、共同編集ページ、Space シークレット",
        competitor: "個人ボード中心。共有は主に成果物のエクスポート依存",
      },
      {
        dimension: "対応プラットフォーム",
        xmatrix: "macOS・Windows・Linux・Android・Web（iPhone・iPad 対応）",
        competitor: "Web、iOS、Chrome 拡張機能（公式 Android アプリなし）",
      },
    ],
    stayWhen: [
      "主目的が個人でのマルチモーダルコンテンツ制作（YouTube 動画やポッドキャストから図解記事・スライド・動画リールを作ること）である。",
    ],
    switchWhen: [
      "リサーチや仕様書を、コーディングエージェントが実際に PR 実装・テスト・デプロイを行うまったく同じ Space に置きたい。",
      "チームメイトと協業している、Android を使っている、またはコーディング契約に加えて月額 $40〜$200 の制作クレジットを払いたくない。",
    ],
    migrationSteps: [
      {
        title: "進行中のリサーチブリーフを生きた xMatrix ページへ移す",
        detail:
          "競合分析・ローンチ計画・設計メモを、エージェントが更新しつつそのまま実行に移せるページへ格納します。",
      },
      {
        title: "コーディングエージェントと公開ツールを連携する",
        detail:
          "自分のマシンで Claude Code・Codex・Gemini を動かし、GitHub（読み取り専用または読み書き）に加え Google Docs・Notion・X・Search Console を Ask first 承認付きで接続します。",
      },
      {
        title: "定期リサーチとレポートを自動化する",
        detail:
          "ページ内にスケジュール実行の Norn プログラムを埋め込み、週次ダイジェストや指標が自動最新化されるようにします。",
      },
    ],
    faqs: [
      {
        question: "xMatrix はコードだけでなく、リサーチや執筆・ローンチ業務にも使えますか？",
        answer:
          "はい。多くのチームがソフトウェア開発と並べて、リサーチ、SEO、プロダクトローンチ、採用、運用業務の生きたページを xMatrix で管理し、エージェントに最新化させています。",
      },
      {
        question: "xMatrix には Android アプリがありますか？",
        answer:
          "はい。xMatrix は macOS・Windows・Linux・Web（iPhone・iPad 対応）に加え、Android アプリも提供しています。",
      },
      {
        question: "外部エージェントや AI アプリからも xMatrix を使えますか？",
        answer:
          "はい。35 種類のコーディングエージェント（および --runtime による任意のカスタム CLI）に対応するほか、外部ツール向けの MCP サーバーも公開しています。",
      },
    ],
  },
  jules: {
    verifiedDate: "2026年11月22日",
    statusNote:
      "Google Jules は 2026年11月11日に読み取り専用モードに入り、2026年12月31日に完全終了します。",
    metaTitle: "Google Jules 代替ツール (2026年12月終了)：xMatrix 移行ガイド",
    metaDescription:
      "Google Jules は 11月11日に読み取り専用となり 2026年12月31日に終了します。エクスポートしたメモリ・スケジュール・GitHub リポジトリを xMatrix へ移し、Antigravity・Claude Code・Codex を併用しましょう。",
    eyebrow: "Google Jules 代替 · 12月31日終了に向けた移行ガイド",
    headline: "12月31日前に Google Jules の非同期 GitHub 作業を移行 — スマホからの起動もそのまま継続",
    lead: "Google Jules は 2026年11月11日に新規セッション受付を終了し、2026年12月31日に完全停止します。しかもメモリ・スケジュール・タスクの自動移行は提供されません。xMatrix ならエクスポートした文脈を生きたページへ取り込み、常時稼働のコンピュータまたは自前 VPS 上で Google Antigravity と他 34 種類のコーディングエージェントを動かしながら、スマホや Web から非同期の GitHub PR 作成を継続できます。",
    productCaption:
      "xMatrix の画面：自分の常時稼働マシンまたは自前 VPS 上で Google Antigravity・Claude Code・Codex を含む 35 種類のコーディングエージェントを動かしながら、Web やモバイルから非同期に GitHub Issue を片付け続けられます。",
    painPoints: [
      {
        title: "2026年12月31日の完全終了と、手動エクスポートのみの引き継ぎ",
        problem:
          "Jules は 11月11日に読み取り専用となり、2026年12月31日に完全終了します。@google/jules で環境変数・メモリ・定期タスク・セッションログを書き出せるものの、Google から Antigravity への自動移行はなく、チームは手作業でワークフローを組み直す必要があります。",
        xmatrixAnswer:
          "xMatrix なら今日すぐ取り込めます。エクスポートした Jules のメモリは生きたページへ、.env シークレットは Space シークレットへ、定期ジョブはページ内の Norn プログラムとして再構築できます。",
      },
      {
        title: "Google Antigravity 単独移行に伴う単一ベンダークォータ不安",
        problem:
          "Hacker News、Reddit、Google AI フォーラムでは、Jules の見通しやすい日次非同期タスク枠を失うことへの不満や、すべてを単一ベンダーの統合クォータプールへ寄せることで予期せぬ上限や超過が起きる懸念が広がっています。",
        xmatrixAnswer:
          "xMatrix は Google Antigravity を他 34 種類のコーディングエージェント（Claude Code・Codex・Cursor・Gemini CLI など）と並べてネイティブ実行でき、1 社のクォータ枠が埋まった際に別プロバイダーへ作業を引き継げます。",
      },
      {
        title: "軽快なモバイル起点・非同期 GitHub バックログ消化の再構築",
        problem:
          "早期移行者からは、Jules を離れたことで「ローカル IDE に張り付かずスマホから非同期に GitHub Issue を PR に変える」軽快な習慣が途切れてしまったという声が出ています。",
        xmatrixAnswer:
          "常時稼働のコンピュータまたは自前 Linux VPS を 1 台接続しておけば、Android や Web（iPhone・iPad 対応）から @auto repo:owner/repo とメンションするか、GitHub イベントで自動起動するだけで、PR・CI 結果・ページ更新が非同期に届きます。",
      },
    ],
    comparisonRows: [
      {
        dimension: "サービス状況（2026年11月時点）",
        xmatrix: "稼働中・セルフサーブ・ソース公開（FSL-1.1-ALv2）",
        competitor: "2026年11月11日より読み取り専用。2026年12月31日に完全終了",
      },
      {
        dimension: "ハーネスとモデルの選択肢",
        xmatrix: "Google Antigravity + 他 34 種類のコーディングエージェント（+ --runtime）+ クォータ引き継ぎ",
        competitor: "Google 専用クラウドエージェント（Google Antigravity へ統合廃止）",
      },
      {
        dimension: "メモリとプロジェクトドキュメント",
        xmatrix: "人とすべてのハーネスが共有する生きた Markdown ページ",
        competitor: "12月31日まで @google/jules CLI でエクスポート可能（自動移行なし）",
      },
      {
        dimension: "定期・イベント駆動タスク",
        xmatrix: "ページ内に組み込む Norn プログラム（cron + GitHub／連携アプリイベント）",
        competitor: "定期タスクは 11月11日に停止。ローカルスナップショットとして書き出しのみ",
      },
      {
        dimension: "コードの実行場所",
        xmatrix: "自分の常時稼働コンピュータまたは自前 Linux VPS（xMatrix ホスト型クラウド VM はなし）",
        competitor: "Google ホストのクラウド VM（12月31日終了）",
      },
    ],
    stayWhen: [
      "2026年12月31日以降も Jules に留まる選択肢はありません。アクセス終了前に npm install -g @google/jules で必ずデータをエクスポートしてください。なお、xMatrix はホスト型クラウド VM ではなく、ご自身の常時稼働コンピュータまたは自前 VPS が必要です。",
    ],
    switchWhen: [
      "単一ベンダーにすべてを賭けるのではなく、Google Antigravity を他 34 種類のコーディングエージェントと併用したい。",
      "エクスポートした Jules のメモリ、環境変数シークレット、定期 GitHub バックログ処理の永続的な移行先が必要。",
      "Mac Studio、デスクトップ、安価な Linux VPS をすでに持っており、クラウドベータの終了で奪われないスマホ起点の非同期 PR ワークフローを求めている。",
    ],
    migrationSteps: [
      {
        title: "2026年12月31日までに Jules データをエクスポートする",
        detail:
          "Google 公式の @google/jules エクスポートツールを実行し、メモリ、定期タスク、セットアップスクリプト、環境変数をローカルに保存します。",
      },
      {
        title: "メモリをページへ、シークレットを Space シークレットへ移す",
        detail:
          "エクスポートしたプロジェクトメモリを xMatrix ページへ貼り付け、.env の機密情報はチャットに貼らず Space シークレットへ登録します。",
      },
      {
        title: "常時稼働マシンまたは自前 VPS と GitHub を接続する",
        detail:
          "常時稼働のデスクトップまたは自前 Linux VPS を xMatrix に登録し、GitHub を連携して定期バックログ巡回をページの Norn プログラムとして再設定します。",
      },
    ],
    faqs: [
      {
        question: "Jules から移行した後も、xMatrix 内で Google Antigravity を動かせますか？",
        answer:
          "はい。xMatrix は自分のマシン上で Google Antigravity（agy）を他 34 種類のコーディングエージェント（Claude Code・Codex・Cursor・Gemini など）と並べてネイティブサポートしています。",
      },
      {
        question: "xMatrix でも Jules のようなホスト型クラウド VM は提供されますか？",
        answer:
          "いいえ。xMatrix にはご自身で管理する常時稼働コンピュータ（デスクトップ、Mac Studio、安価な自前 Linux VPS など）が必要で、xMatrix ホスト型のクラウド VM はありません。その代わりベンダーロックインがなく、ホスト型クラウドベータの終了でリポジトリやワークフローが消えることがありません。",
      },
      {
        question: "Jules の定期タスクは xMatrix でどう置き換えますか？",
        answer:
          "xMatrix のプロジェクトページ内に Norn プログラムブロックを直接追加してください。指定スケジュールまたは GitHub イベントで自動実行され、結果がそのページへ書き込まれます。",
      },
    ],
  },
};
