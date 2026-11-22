---
title: "Claude Code や Codex でプロジェクト Wiki を作る · xMatrix ドキュメント"
description: "プロジェクトのメモを、自分の Claude Code や Codex エージェントが常に最新に保つ生きた Wiki に変えましょう。ステータスページの作成、確認、チャットからの更新手順を解説します。"
---

# Claude Code や Codex でプロジェクト Wiki を作る

xMatrix 上で、自分自身の Claude Code または Codex エージェントを使ってプロジェクトのメモを生きた Wiki に変えてみましょう。プロジェクトのステータスページを作成し、決定事項と残タスクを確認し、状況が変わったら同じ会話からページを更新します。

オープンソースプロジェクトなら、次のリリースから始めるのがおすすめです。合意済みのこと、ブロッカー、次のステップの担当者をまとめましょう。GitHub を連携したりメンバーを招待したりする前に、手元のメモとローカルフォルダだけで試せます。

## 始める前に

Claude Code または Codex がインストールされサインイン済みのコンピュータと、xMatrix アカウントが必要です。エージェントは既存のツールアカウントを使ってあなたのコンピュータ上で実行されるため、作業中はコンピュータをオンラインにしておいてください。会話のやり取りやページの閲覧には Web アプリを使います。

まだこのコンピュータを接続していない場合は、[インストールとサインイン](index.md#install)を先に済ませ、[Web アプリ](https://xmatrix.sh/app)で Space を開いてください。

## エージェントにフォルダを渡す

最初のページ作成には空のフォルダがあれば十分です。macOS または Linux では、次のコマンドでフォルダを作成して Codex を Space に追加します。

```sh
mkdir -p ~/xmatrix/project-wiki
xmatrix spaces
xmatrix agent add codex --space <space-id> --workspace ~/xmatrix/project-wiki
```

`<space-id>` は開いている Space の ID に置き換えてください。Claude Code を使う場合は `codex` を `claude` に変更します。Windows の場合は `C:\xmatrix\project-wiki` のようなフォルダを作成し、`--workspace` にそのパスを指定してください。

フォルダのフルパスを確認するには、macOS / Linux では `echo "$HOME/xmatrix/project-wiki"`、PowerShell では `Resolve-Path C:\xmatrix\project-wiki` を実行します。下のメッセージにそのパスを引用符ごと指定します。エージェント登録と対応ツールの詳細は[エージェントの運用](agents.md)を参照してください。

## 最初のページ作成を依頼する

Space 内で新しい会話を作成します。パスとメモの例を自分のプロジェクトの実際の情報に書き換えて、次のメッセージを貼り付けてください。Claude Code を追加した場合は `@claude` に変更します。

```text
@codex pwd:"/full/path/to/project-wiki"
Create a page called Release status from these notes.
Use sections for Goal, Decisions, Open work and Next steps.
Keep unknown owners or dates marked unknown.
Work from these notes and link the page here when it is ready.

Goal: Ship the next release with a usable installation guide.
Decided: Support macOS and Windows first. Linux is still open.
Open work: Check the Windows instructions.
The owner and release date are not decided.
Next: Ask a maintainer to try a clean Windows install.
```

フォルダはエージェントの実行場所を指定するためのものです。ページの内容はメモから作成されるため、このタスクではリポジトリへのアクセスは不要です。Windows でも同じ `pwd:` 構文で Windows のフルパスを指定できます。

エージェントの返信を待ってページリンクを開くか、**Pages** から **Release status** を見つけてください。決定事項と未決事項がきちんと分かれており、未定の担当者や日付が不明（unknown）のままになっているか確認しましょう。誤りがあれば会話の中で訂正を指示します。

エージェントから返信がない場合は、コンピュータ上で `xmatrix status` と `xmatrix agent list --space <space-id>` を実行し、エージェントが有効になっていること、およびコーディングツールにサインインしていることを確認してください。起動に失敗した場合は会話内の呼び出し詳細に理由が表示されます。次の確認手順は[エージェントのセットアップ](agents.md)を参照してください。

## 決定を変更し、ページの更新を確認する

返信してきたインスタンス宛てに続けてメッセージを送ります。たとえば `codex:1` として現れた場合は次のように送信します。

```text
@codex:1 Windows installation has now been checked.
Update Release status: remove that open item.
Make the next step choosing a release date.
Leave the date unknown until we agree on it.
```

実際の会話に表示された名前と番号を使用してください。同じページを再度開き、完了した未決項目が消え、次のステップが更新されていることを確認します。これが xMatrix の価値です。スレッドを読み返して計画を頭の中で組み立て直す代わりに、常に最新の 1 ページへ戻れば状況がひと目でわかります。

## 実際のプロジェクト業務に活用する

次の決定事項、Issue の要約、リリースノートなども会話に持ち込み、既存ページの更新をエージェントに依頼しましょう。コードを確認させる必要があるときは、実際のプロジェクトフォルダへのアクセス権を付与します。GitHub の Issue やプルリクエストを読ませたい場合は、先に [GitHub](connectors.md#github) を Space に連携し、タスク内でリポジトリを指定します。

1 つの事実は 1 か所にだけ書くようにしましょう。プロジェクトの成長に合わせて子ページを追加し、Release status からリンクします。ページツリー、同時編集、定期更新の仕組みは[ページ](pages.md)で解説しています。

ページは、Space のオーナーまたは管理者が明示的に公開するまで非公開のままです。チーム外へ共有する前に内容とアクセス権限を確認してください。この Wiki を作成しただけでは外部に公開されません。
