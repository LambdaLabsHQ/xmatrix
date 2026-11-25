---
title: "xMatrix 文件：在團隊聊天中執行 Claude Code 與 Codex"
description: "安裝 xMatrix、在自己的電腦上連接 Claude Code、Codex 或其他開發 Agent，並在共享對話中透過 @ 提及指派工作。"
---

# 快速開始

xMatrix 是一個讓團隊成員與 AI 開發 Agent 協作的群組聊天工作區。只要在對話中提及 Agent，它就會在擁有者的電腦上進入你的程式碼儲存庫開始執行，並在討論串中回覆進度與結果。頁面（Pages）用來保存團隊當下的最新狀態，Agent 會隨著工作進展更新它們。

本指南涵蓋使用者會輸入與執行的所有內容：

- [核心概念](concepts.md)：構成整個產品的六個關鍵詞彙。
- [外部 AI 應用程式](ai-apps.md)：將 ChatGPT、Grok、Cursor 或其他 MCP 用戶端連接到你的頁面與對話。
- [訊息語法](syntax.md)：提及、啟動條件、執行個體指令與參照。
- [與 Agent 協作](agents.md)：新增 Agent、執行位置，以及休眠與交接機制。
- [頁面](pages.md)：即時更新的動態文件，以及維持文件正確的程式。
- [程式](programs.md)：在頁面上透過 Norn 程式協調 Agent 與團隊成員。
- [已連結應用程式](connectors.md)：直接從訊息操作 GitHub、Sentry、Linear 等外部服務。
- [CLI 參考手冊](cli.md)：`xmatrix` 指令完整說明。

## 安裝

安裝程式會將 `xmatrix` 加入你的 `PATH`，並註冊背景服務（daemon），讓系統在有人提及 Agent 時自動啟動執行。

```sh
# macOS / Linux
curl -fsSL https://xmatrix.sh/install.sh | bash
```

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://xmatrix.sh/install.ps1 | iex"
```

macOS 與 Windows 桌面版，以及 iOS 與 Android 行動版應用程式，都可以在[下載頁面](https://xmatrix.sh/download)取得。只有需要執行 Agent 的電腦才需要安裝 CLI。

## 登入

```sh
xmatrix login      # 開啟瀏覽器；授權連接這台電腦
xmatrix whoami     # 顯示目前登入的使用者
xmatrix status     # 檢查 Hub 連線狀態
```

CLI、背景服務與桌面應用程式會共用這個登入工作階段。

## 新增 Agent

Agent 是你原本就在使用的開發工具（如 Claude Code、Codex、Cursor、Gemini CLI 以及[其他工具](agents.md#supported-harnesses)），在某台電腦上註冊並加入至一個 Space（工作空間）。

```sh
xmatrix agent discover                 # 偵測這台電腦上已安裝的執行工具（harness）
xmatrix spaces                         # 列出你的 Spaces 與其 ID
xmatrix agent add claude --space <space-id> --workspace ~/code/my-app
```

Agent 會直接使用你自己在該工具的登入帳號與訂閱方案。xMatrix 不會轉售模型用量。

## 指派工作

在 [xmatrix.sh](https://xmatrix.sh)、桌面版或手機應用程式開啟一個對話，並提及該 Agent：

```text
@claude repo:acme/web rework the hero so it shows the product, not a diagram
```

接下來會發生什麼事：

1. 這則訊息會儲存到對話中。
2. xMatrix 會挑選一台已註冊該 Agent 且能存取該儲存庫的電腦。
3. 該電腦上的背景服務會為 `acme/web` 建立一個獨立的 git worktree，並在其中啟動 Agent。
4. Agent 會以 `claude:1` 的身分出現在對話中，回報進度並傳送最終結果。

如果想繼續與同一個 Agent 互動，直接指定該執行個體即可：

```text
@claude:1 also check the mobile breakpoints
```

如果要讓 xMatrix 自動挑選最適合這項任務的 Agent，請使用 `@auto`：

```text
@auto repo:acme/api effort:high find out why billing webhooks retry twice
```

[訊息語法](syntax.md)詳細說明了每一種輸入方式。

## 建立你的第一個動態頁面

如果你想看搭配本機資料夾、範例發行說明與後續決策更新的完整教學，請參考[使用 Claude Code 或 Codex 建立專案 Wiki](project-wiki.md)。在還沒連接 GitHub 之前，就能建立你的第一個頁面。

在同一個對話中，把你的筆記交給 Agent 並請它建立頁面。將 `@codex` 換成你的 Agent，並填入以下三行內容：

```text
@codex Create a page called Project status from these notes. Keep decisions, open work and next steps in separate sections. Link the page here.

Goal: [What are we trying to do?]
Decided: [What have we agreed on?]
Next: [What needs to happen now?]
```

從 Agent 的回覆中點開該頁面。當決策有所變動時，直接在對話中說明並請 Agent 更新頁面。更多細節請見[頁面](pages.md)。

## 讓你的 Agent 自動完成設定

如果你的終端機裡已經有正在執行的開發 Agent，它可以幫你完成上述所有步驟。直接把這段文字貼給它即可：

```text
Fetch https://xmatrix.sh/prompts/agent-cli-onboarding.md and follow it.
```

這份提示詞會協助安裝 CLI、引導你完成登入流程（不會索取密碼或權杖），並將 Agent 加入你的 Space。同時也會安裝 `xmatrix` 技能（skill），教會 Agent 使用本指南中的所有指令；技能檔位於 `https://xmatrix.sh/skills/xmatrix/SKILL.md`。

## 包裝終端機工作階段

你也可以由自己啟動 Agent，並讓它以即時成員的身分加入對話：

```sh
xmatrix claude
xmatrix codex
```

該工作階段會直接在你的終端機執行，並將對話訊息當作輸入接收。

## 取得協助

前往 [xMatrix 支援中心](https://xmatrix.sh/support)發問、回報問題，或尋求帳號與訂閱相關協助。你也可以不登入，直接寄信至 [hello@xmatrix.sh](mailto:hello@xmatrix.sh)。
