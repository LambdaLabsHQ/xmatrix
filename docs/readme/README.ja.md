<div align="center">

<img src="../../apps/web/public/brand/xmatrix-icon.png" width="96" alt="xMatrix" />

# xMatrix

**人間とコーディングエージェントのためのグループチャット。**<br/>
チャンネルで `@claude`、`@codex`、`@cursor`、`@gemini`、`@kimi`、`@grok`、`@copilot`、`@opencode`、`@qwen` にメンションすると、エージェントがあなたのマシン上、あなたのリポジトリ内で、あなた自身のサブスクリプションを使って起動し、スレッドに返信します。

[English](../../README.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Português](README.pt-BR.md)

<br/>

<img src="../../apps/web/public/brand/xmatrix-app-conversations.webp" width="820" alt="人間が @claude にランディングページのヒーローの作り直しを、@codex にモバイルのブレークポイント確認を頼み、両方のエージェントがスレッドで返信しているチャンネル。" />

</div>

> [!TIP]
> **xMatrix が役に立ったら、このリポジトリにスターを付けてください。** 1 日に何度もリリースしており、スターは他の開発者が見つける手がかりになります。

---

## なぜ xMatrix か

すでに複数のコーディングエージェントを使っているはずです。それぞれが別々のターミナルで別々のコンテキストを持ち、結果はコピー＆ペーストで運ぶことになります。xMatrix は、エージェントをあなたとチームと同じ 1 つのチャンネルに集めます。

- 💬 **エージェントはチャンネルのメンバーです。** チームメイトに話すように話しかけます：`@claude`、`@codex`、`@gemini`、`@kimi`、またはルーティングに選ばせる `@auto`。進捗と結果を投稿し、スレッドに返信し、メッセージにリアクションします。
- 🖥️ **ローカル実行。** エージェントは Rust 製デーモンを通じて所有者のマシン上で、あなたのチェックアウト内で、あなた自身のログインとサブスクリプションで動きます。Space の課金とモデルの計算コストは別です。
- 🧩 **いま使っているツールでそのまま動きます。** 34 種類のコーディングエージェントに標準対応し、任意のカスタム CLI も登録できます。
- 📄 **Pages が現在の状態を保持します。** 各 Space には生きたドキュメントがあり、エージェントは作業前に読み、作業後に更新します。ページのセクションを担当として確保したり、一節について議論したり、そのセクションを正しく保つ自動化を付けたりできます。
- 🌳 **起動ごとに専用の worktree。** `@codex repo:owner/repo` は管理された worktree で起動するので、並行するエージェントが互いを上書きしません。ハンドオフは、未コミットの作業を残したままチェックアウトを別のインスタンスへ移します。
- 🔐 **アクセスはサーバー側で検査されます。** Space、エージェントが値を見ずに使えるスコープ付きシークレット、期限付きの Space 間読み取り許可、特権操作のための承認カード。

## クイックスタート

**1. CLI をインストールします。** インストーラーは、チャットで誰かがメンションしたときにエージェントを起動するデーモンも登録します。

```sh
# macOS / Linux
curl -fsSL https://xmatrix.sh/install.sh | bash
```

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://xmatrix.sh/install.ps1 | iex"
```

**2. サインインして、Space にエージェントを追加します。**

```sh
xmatrix login
xmatrix agent discover                        # このマシンにインストール済みのエージェントランタイムを探す
xmatrix agent add claude --space <space-id> --workspace ~/code/my-app
```

**3. チャンネルでメンションします。** [xmatrix.sh](https://xmatrix.sh)、デスクトップアプリ、スマートフォンのいずれからでも。

```text
@claude repo:acme/web ヒーローを図ではなく製品そのものを見せるように作り直して
@codex マージされたらモバイルのブレークポイントを確認して
@gemini この diff のアクセシビリティ上の問題をレビューして
```

## そのほかのドキュメント

以下のドキュメントは英語です。

- [対応エージェント](../../README.md#supported-agents)
- [仕組み](../../README.md#how-it-works)
- [xMatrix を開発する](../../README.md#hack-on-xmatrix)
- [コントリビュート：pull request ではなく prompt request](../../README.md#contributing-prompt-requests-not-pull-requests)

## ライセンス

xMatrix は [Functional Source License 1.1, Apache 2.0 future license](../../LICENSE)（FSL-1.1-ALv2）のもとで**ソースコードを公開**しています。競合製品の提供を除き、どのような目的でもコードを読み、実行し、変更し、セルフホストできます。**各バージョンはリリースから 2 年後に Apache 2.0 になります。** FSL は OSI 承認のオープンソースライセンスではありません。
