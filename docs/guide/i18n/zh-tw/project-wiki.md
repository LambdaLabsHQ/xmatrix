---
title: "使用 Claude Code 或 Codex 建立專案 Wiki · xMatrix 文件"
description: "用自己的 Claude Code 或 Codex Agent 在 xMatrix 將專案筆記變成持續更新的動態 Wiki：建立狀態頁面、檢視內容，並直接從聊天室更新。"
---

# 使用 Claude Code 或 Codex 建立專案 Wiki

在 xMatrix 中，運用你自己的 Claude Code 或 Codex Agent，將專案筆記轉換成持續保持最新的動態 Wiki。建立一份專案狀態頁面、檢視其中的決策與待辦事項，並在情況變動時直接於同一個對話中更新頁面。

如果是開源專案，可以先從下一個版本發布開始整理：目前已達成共識的事項、卡關的阻礙，以及下一步由誰負責。你不需要先連接 GitHub 或邀請其他人，只要幾段筆記和一個本機資料夾就能開始嘗試。

## 開始之前

你需要一台已安裝並登入 Claude Code 或 Codex 的電腦，以及一個 xMatrix 帳號。Agent 會使用你原本的工具帳號，並直接在你的電腦上執行，因此執行期間請保持電腦連線。網頁版應用程式則是你與 Agent 對話以及閱讀頁面（Pages）的地方。

如果還沒連接這台電腦，請先依照[安裝與登入](index.md#install)步驟操作，並在[網頁版應用程式](https://xmatrix.sh/app)開啟你的 Space。

## 指派一個資料夾給 Agent

建立這第一份頁面只需要一個空資料夾。在 macOS 或 Linux 上，以下指令會建立資料夾並將 Codex 加入你的 Space：

```sh
mkdir -p ~/xmatrix/project-wiki
xmatrix spaces
xmatrix agent add codex --space <space-id> --workspace ~/xmatrix/project-wiki
```

請將 `<space-id>` 替換為你開啟的 Space ID。若使用的是 Claude Code，請將 `codex` 改為 `claude`。在 Windows 上，可以建立如 `C:\xmatrix\project-wiki` 的資料夾，並將該路徑填入 `--workspace`。

在 macOS 或 Linux 上執行 `echo "$HOME/xmatrix/project-wiki"`，或在 PowerShell 執行 `Resolve-Path C:\xmatrix\project-wiki`，即可取得資料夾的完整路徑。將該路徑（含雙引號）填入下方訊息中。關於註冊方式與支援的工具清單，請參考[與 Agent 協作](agents.md)。

## 請 Agent 建立第一份頁面

在你的 Space 中建立一個新對話。貼上以下訊息，並將路徑與範例筆記換成你專案的真實資訊。如果你加入的是 Claude Code，請改用 `@claude`。

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

該資料夾會決定 Agent 的執行位置。內容由你的筆記提供，這項任務不需要存取程式碼儲存庫。在 Windows 上同樣使用 `pwd:` 語法並填入完整的 Windows 路徑即可。

等待 Agent 回覆並開啟它附上的頁面連結，或在 **Pages** 中找到 **Release status**。確認頁面已將「決策」與「待確認問題」清楚分開，且尚未決定的負責人與日期仍標示為未知。若有任何寫錯的地方，直接在對話中修正即可。

如果沒有 Agent 回覆，請在電腦上執行 `xmatrix status` 與 `xmatrix agent list --space <space-id>` 進行檢查，確認 Agent 處於啟用狀態且對應的開發工具已完成登入。對話中的呼叫詳情會顯示啟動失敗的原因；更多排查步驟請參閱[與 Agent 協作](agents.md)。

## 變更決策並即時觀察頁面更新

直接回覆剛才回應你的那個執行個體。例如，如果它顯示為 `codex:1`，請傳送：

```text
@codex:1 Windows installation has now been checked.
Update Release status: remove that open item.
Make the next step choosing a release date.
Leave the date unknown until we agree on it.
```

請使用你對話中實際顯示的名稱與編號。重新開啟同一個頁面，確認舊的待辦項目已經移除，且下一步也已更新。這就是動態頁面的核心價值：隨時回來都能看到一份維持最新狀態的頁面，不必反覆重讀冗長的討論串來拼湊計畫。

## 應用於真實專案開發

往後有新的決策、Issue 摘要或發行說明時，直接帶進對話中，請 Agent 更新現有頁面。當它需要檢視程式碼時，再授權給它你的真實專案資料夾。如果需要讓它讀取 GitHub Issues 或 Pull Requests，請先將 [GitHub](connectors.md#github) 連接到 Space，並在任務中指定對應的儲存庫。

讓每一項事實只維護在一個地方。專案成長後可以新增子頁面，並從 Release status 連結過去。關於頁面樹狀結構、多人同時編輯與排程更新，請參閱[頁面](pages.md)。

頁面在 Space 擁有者或管理員主動發布之前都會維持不公開。對團隊外部公開前，請先檢視頁面內容與存取權限；建立這份 Wiki 並不會自動將其公開。
