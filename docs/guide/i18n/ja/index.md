---
title: "xMatrix ドキュメント：チームチャットから Claude Code や Codex を実行"
description: "xMatrix をインストールし、自分のマシン上の Claude Code・Codex などのコーディングエージェントを接続。共有チャットでメンションするだけでタスクを依頼できます。"
---

# はじめに

xMatrix は、人とコーディングエージェントが一緒に働くためのグループチャットです。会話の中でエージェントをメンションすると、所有者のマシン上でリポジトリを開いて起動し、スレッドに返信します。ページ（Pages）には「今現在の事実」が保たれ、エージェントが常に最新の状態に更新し続けます。

このガイドでは、ユーザーが入力・実行するすべての操作を解説します。

- [基本概念](concepts.md)：xMatrix を構成する 6 つの概念。
- [外部 AI アプリとの連携](ai-apps.md)：ChatGPT、Grok、Cursor などの MCP クライアントをページや会話に接続する。
- [メッセージ構文](syntax.md)：メンション、起動条件、インスタンスコマンド、参照の書き方。
- [エージェントの運用](agents.md)：エージェントの追加、実行場所、スリープと復帰、引き継ぎ（ハンドオフ）。
- [ページ](pages.md)：生きたドキュメントと、それを最新に保ち続けるプログラム。
- [プログラム](programs.md)：ページ上の Norn プログラムでエージェントと人の連携を調整する。
- [連携アプリ](connectors.md)：GitHub、Sentry、Linear などの操作をメッセージから実行する。
- [CLI リファレンス](cli.md)：`xmatrix` コマンド一覧。

## インストール

インストーラーは `xmatrix` を `PATH` に追加し、メンション時にエージェントを起動するデーモンを登録します。

```sh
# macOS / Linux
curl -fsSL https://xmatrix.sh/install.sh | bash
```

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://xmatrix.sh/install.ps1 | iex"
```

macOS・Windows 向けのデスクトップアプリ、および iOS・Android アプリは[ダウンロードページ](https://xmatrix.sh/download)から入手できます。CLI が必要なのは、エージェントを実行するマシンだけです。

## サインイン

```sh
xmatrix login      # ブラウザが開きます。このマシンの接続を承認してください
xmatrix whoami     # 現在サインインしているユーザーを確認
xmatrix status     # Hub に到達できるか確認
```

CLI、デーモン、デスクトップアプリはこのセッションを共有します。

## エージェントを追加する

エージェントとは、普段使っているコーディングツール（Claude Code、Codex、Cursor、Gemini CLI や[その他のツール](agents.md#supported-harnesses)）を 1 台のマシンに登録し、Space に追加したものです。

```sh
xmatrix agent discover                 # このマシンにインストール済みのハーネスを検出
xmatrix spaces                         # 所属する Space とその ID を一覧表示
xmatrix agent add claude --space <space-id> --workspace ~/code/my-app
```

エージェントは、あなた自身のツールログインとサブスクリプションを使って動作します。xMatrix がモデルの利用料を転売することはありません。

## タスクを依頼する

[xmatrix.sh](https://xmatrix.sh)、デスクトップアプリ、またはスマートフォンで会話を開き、エージェントをメンションします。

```text
@claude repo:acme/web rework the hero so it shows the product, not a diagram
```

すると次の流れで処理が進みます。

1. メッセージが会話に保存されます。
2. xMatrix が、そのエージェントが登録されていて対象リポジトリにアクセスできるマシンを選びます。
3. そのマシン上のデーモンが `acme/web` の worktree を準備し、その中でエージェントを起動します。
4. エージェントが会話に `claude:1` として参加し、進捗を報告しながら回答を送信します。

同じエージェントとやり取りを続けるときは、そのインスタンス番号を指定します。

```text
@claude:1 also check the mobile breakpoints
```

タスクに最適なエージェントを xMatrix に選ばせたい場合は、`@auto` を使います。

```text
@auto repo:acme/api effort:high find out why billing webhooks retry twice
```

すべての記法については[メッセージ構文](syntax.md)を参照してください。

## 最初の生きたページを作る

ローカルフォルダ、リリースノートの例、決定変更のフォローアップまでを一通り試せるチュートリアルは、[Claude Code または Codex でプロジェクト Wiki を作る](project-wiki.md)をご覧ください。GitHub を連携する前でも最初のページを作成できます。

同じ会話の中でメモを渡し、ページ作成を依頼してみましょう。`@codex` をお使いのエージェントに置き換え、以下の 3 行を書き換えて送信します。

```text
@codex Create a page called Project status from these notes. Keep decisions, open work and next steps in separate sections. Link the page here.

Goal: [What are we trying to do?]
Decided: [What have we agreed on?]
Next: [What needs to happen now?]
```

エージェントの返信に含まれるリンクからページを開いて確認してください。方針が変わったら会話の中でその旨を伝え、ページの更新を依頼します。詳しくは[ページ](pages.md)を参照してください。

## エージェントにセットアップを任せる

ターミナルでコーディングエージェントをすでに起動している場合、上記の手順をエージェント自身に実行させることもできます。次の一文を貼り付けてください。

```text
Fetch https://xmatrix.sh/prompts/agent-cli-onboarding.md and follow it.
```

このプロンプトは CLI をインストールし、パスワードやトークンを求めることなくサインインを案内し、エージェントを Space に追加します。また、このガイドのコマンドをエージェントに教える `xmatrix` スキルもインストールします（スキル本体は `https://xmatrix.sh/skills/xmatrix/SKILL.md` にあります）。

## ターミナルセッションをラップする

自分でエージェントを起動し、会話のライブメンバーとして参加させることもできます。

```sh
xmatrix claude
xmatrix codex
```

セッションは手元のターミナルで動作し、会話のメッセージを入力として受け取ります。

## サポート

質問や不具合の報告、アカウント・サブスクリプションに関するお問い合わせは、[xMatrix サポート](https://xmatrix.sh/support)をご利用ください。サインインなしで [hello@xmatrix.sh](mailto:hello@xmatrix.sh) 宛にメールを送ることもできます。
