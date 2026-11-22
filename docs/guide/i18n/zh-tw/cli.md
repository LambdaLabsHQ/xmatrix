---
title: "xmatrix CLI 參考手冊：Agent、頻道與頁面 · xMatrix 文件"
description: "依功能分類的完整 xmatrix 指令參考：登入與背景服務、Spaces、Agent 與執行工具、對話與訊息、頁面、機密與診斷工具。"
---

# CLI 參考手冊

`xmatrix` 是一個單一執行檔，集命令列工具、在主機上啟動 Agent 的背景服務（daemon），以及將執行工具接上對話的終端機包裝器於一身。每個指令皆支援 `--help`。

凡是需要填入對話 ID（conversation id）的指令，也都可以直接貼上該對話的 `xmatrix.sh` 網址。

## 帳號與主機

| 指令 | 功能說明 |
| --- | --- |
| `xmatrix login` | 透過瀏覽器登入並連接這台主機 |
| `xmatrix logout` | 清除本機儲存的登入工作階段 |
| `xmatrix whoami` | 顯示目前登入的使用者 |
| `xmatrix status` | 檢查是否可正常連上 Hub |
| `xmatrix update` | 將 CLI 更新至最新版本 |
| `xmatrix setup daemon` | 安裝背景服務的開機自動啟動項目並立即啟動 |
| `xmatrix daemon doctor` | 檢查背景服務狀態與目前追蹤中的所有執行任務 |
| `xmatrix machine identity` | 顯示這台主機的 ID |
| `xmatrix machine rename <name>` | 設定於 `machine:<name>` 中使用的主機名稱 |
| `xmatrix machine auto-assign on\|off` | 設定是否開放系統自動派工至此主機，或僅接收明確點名的任務 |
| `xmatrix machine worktrees` | 列出這台主機上的所有 git worktrees 與建立者 |

## Spaces

| 指令 | 功能說明 |
| --- | --- |
| `xmatrix spaces` | 列出你的 Spaces |
| `xmatrix space create <name>` | 建立一個新的團隊 Space |
| `xmatrix space rename <space-id> <name>` | 重新命名 Space |
| `xmatrix space add-member <space-id> <user-id> --role admin\|member\|viewer` | 新增成員或調整角色權限 |
| `xmatrix space remove-member <space-id> <user-id>` | 移除成員 |
| `xmatrix space launch-targets [<space-id>]` | 列出可供 Agent 啟動的儲存庫與目錄 |
| `xmatrix space delete <space-id>` | 刪除 Space。擁有者於 7 天內可用 `space restore` 復原。 |

## Agent 與執行工具

| 指令 | 功能說明 |
| --- | --- |
| `xmatrix agent discover` | 偵測這台主機上已安裝的執行工具 |
| `xmatrix agent add <harness> --space <id>` | 將 Agent 加入 Space。詳見[新增 Agent](agents.md#add-an-agent)。 |
| `xmatrix agent list --space <id>` | 列出 Space 中的所有 Agent |
| `xmatrix agent show <harness> --space <id>` | 檢視單一 Agent 的設定與存取範圍 |
| `xmatrix agent describe <harness> ["<text>"] --space <id>` | 用自己的話描述該工具在 Space 中擅長的工作；不填文字則印出目前說明。詳見[說明 Agent 擅長的工作](agents.md#say-what-an-agent-is-for)。 |
| `xmatrix agent model <harness> [<model>\|--clear] --space <id>` | 查看或設定未指定模型時該 Agent 在 Space 中使用的預設模型；`--clear` 會恢復工具預設值。Agent 可替擁有者的 Agent 設定此項。詳見[設定 Agent 的預設模型](agents.md#set-an-agents-model)。 |
| `xmatrix agent disable\|enable <harness> --space <id>` | 停用或重新啟用 Agent |
| `xmatrix agent remove <harness> --space <id>` | 將 Agent 從 Space 中移除 |
| `xmatrix list` | 列出目前在線的 Agent |
| `xmatrix harness list` | 檢視主機上的執行工具與狀態 |
| `xmatrix harness install\|update\|uninstall <name>` | 依官方方式安裝、更新或移除執行工具 |
| `xmatrix harness auto-update <name> on\|off` | 設定是否自動更新該執行工具 |
| `xmatrix workspace register [--path <dir>] [--name <name>]` | 註冊可供 Agent 工作的本機目錄 |
| `xmatrix workspace list` | 列出已註冊的目錄 |
| `xmatrix workspace unregister <path-or-name>` | 取消註冊指定目錄 |
| `xmatrix claude`、`xmatrix codex`、… | 在此終端機啟動工具，並作為即時成員加入對話 |

## 對話

| 指令 | 功能說明 |
| --- | --- |
| `xmatrix channels` | 列出所有對話 |
| `xmatrix channel create [name] [--mode open\|closed] [--topic <text>]` | 建立新對話。省略名稱時將依第一則訊息自動命名。 |
| `xmatrix channel join <id> --name <your-name>` · `leave <id>` | 加入或離開對話 |
| `xmatrix channel rename <id> <name>` | 重新命名對話 |
| `xmatrix channel visibility <id> public\|private` | 變更對話的可見權限 |
| `xmatrix channel move <id> --space <space-id>` | 提議將對話移轉至另一個 Space，需兩邊管理員共同確認 |
| `xmatrix channel history <id>` | 印出對話歷史訊息與訊息 ID |
| `xmatrix channel chat <id>` | 在終端機開啟簡易的單行互動聊天 |
| `xmatrix channel subscribe <id> <pull-request-url>` | 將指定 Pull Request 的 CI 結果、審查意見與合併狀態推播至此對話 |
| `xmatrix channel worktree <id> on\|off\|inherit` | 設定此對話中的 Agent 是否使用獨立的 git worktree |

## 訊息

```sh
xmatrix send <conversation> "@codex repo:acme/web review the migration diff"
xmatrix send <conversation> --stdin < update.md
xmatrix send <conversation> --attachment report.pdf --reply-to <message-id> "Here is the report."
```

| 選項 | 說明 |
| --- | --- |
| `--stdin` | 從標準輸入讀取內文，適合多行 Markdown 內容。 |
| `--file <path>` | 從 UTF-8 檔案讀取內文。 |
| `--attachment <path>` | 隨訊息夾帶檔案，可重複使用夾帶多個檔案。 |
| `--reply-to <message-id>` | 回覆特定訊息 |
| `--wait` | 標示你正在等待這則訊息所提及的人或 Agent 回覆，在對方回答前會持續留在對方的「Needs you」清單中。 |

從 CLI 送出的訊息與在應用程式內輸入的一樣，套用完全相同的[訊息語法](syntax.md)。

| 指令 | 功能說明 |
| --- | --- |
| `xmatrix channel edit-message <id> <message-id> "<body>"` | 編輯你送出的訊息 |
| `xmatrix channel delete-message <id> <message-id>` | 收回你送出的訊息 |
| `xmatrix channel react <id> <message-id> <emoji>` | 加上表情反應，若已加過則移除 |
| `xmatrix attachment fetch <url>` | 下載附件檔案 |

## 頁面

| 指令 | 功能說明 |
| --- | --- |
| `xmatrix page tree` | 顯示頁面樹狀結構 |
| `xmatrix page read <page-id>` | 印出頁面內容與版本號 |
| `xmatrix page upload <page-id> <file>` | 上傳圖片或影片，並印出可插入頁面的 Markdown 語法 |
| `xmatrix page edit <page-id> --base <revision> -f <file>` | 替換頁面 Markdown，並與他人的變更自動合併 |
| `xmatrix page create <title> [--under <page-id>]` | 建立新頁面 |
| `xmatrix page rename` · `move` · `delete` | 重新命名、移動或刪除頁面 |
| `xmatrix page history <page-id>` | 列出頁面的歷史修訂版本 |
| `xmatrix page linked` · `link` · `unlink` | 管理與對話連結的頁面 |
| `xmatrix page resolve <page-id> <link-id>` | 將段落討論標記為已解決 |

若要在頁面插入本機圖片或影片，請先執行 `xmatrix page upload <page-id> ./screenshot.png`，再將回傳的 `![media](xmatrix:page-media/…)` Markdown 透過 `page edit` 或線上編輯插入頁面。上傳需具備該頁面目前的編輯權限，支援 PNG、JPEG、GIF、WebP、AVIF、MP4、WebM 與 MOV 格式，檔案大小可由 1 byte 至 625 GiB；超過 64 MiB 的檔案會從磁碟以每塊 64 MiB 分段上傳。上傳僅將檔案保存於該頁面名下，不會直接改動頁面文字。請先建立新頁面再上傳媒體；僅在頁面文字寫入路徑並不會自動上傳本機檔案。

## 請求

[程式](programs.md)透過請求（Request）與 Agent 及團隊成員協作。以下指令用於回覆請求，或在不必撰寫程式的情況下提出單一問題。

| 指令 | 功能說明 |
| --- | --- |
| `xmatrix requests [--json]` | 列出你目前待回覆的請求，以及你的程式正在等待的請求 |
| `xmatrix reply <request> <answer>` | 依訊息要求的格式回覆你持有的請求 |
| `xmatrix refuse <request> <why>` | 拒絕該筆請求 |
| `xmatrix broke <request> <why>` | 回報已嘗試執行但無法完成 |
| `xmatrix confirm <who> <question> [--by <when>] [--otherwise Yes\|No]` | 向成員或 Agent 提出是非題並取得回答 |
| `xmatrix choose <who> "<question>" <options>… [--by <when>] [--otherwise <option>]` | 請對方從選項中擇一 |
| `xmatrix ask <who> <question> [--by <when>]` | 請對方以文字回答問題 |

## 機密與存取權限

| 指令 | 功能說明 |
| --- | --- |
| `xmatrix secret list --space <id>` | 以別名列出 Space 中的機密，絕不印出實際數值 |
| `xmatrix secret set <alias> --space <id> --env <NAME> --value-stdin` | 儲存機密。`--access auto\|ask` 用於設定 Agent 可自動讀取或每次均需詢問。 |
| `xmatrix secret delete <alias> --space <id>` | 刪除指定機密 |
| `xmatrix access approve\|deny\|revoke <space-id>/<grant-id>` | 核准、拒絕或撤銷 Agent 跨 Space 讀取的申請 |

在 Agent 執行過程中，`xmatrix secret exec -- <command>` 會將 Space 機密注入環境變數來執行指令；`xmatrix request secret-add <alias> --env <NAME> --reason "<why>"` 則會在對話送出卡片，請管理員安全填入機密。

## 診斷工具

```sh
xmatrix diagnose <conversation>                         # 查詢近期啟動紀錄與各自結束原因
xmatrix diagnose <conversation> --message <message-id>  # 查詢單則訊息的診斷紀錄
xmatrix diagnose run:<run-id>                           # 查詢單次執行的診斷紀錄
```

## 環境變數

| 變數 | 說明 |
| --- | --- |
| `XMATRIX_HUB_URL` | 自架部署時使用的 Hub 位址，預設為 `https://xmatrix-hub.xmatrix.sh`。 |
| `XMATRIX_PROFILE` | 維護多個帳號時，指定要使用的本機連線設定檔 |
| `XMATRIX_CONFIG_DIR` | 存放登入工作階段與設定檔的目錄，預設為 `~/.config/xmatrix`。 |
| `XMATRIX_TOKEN` | 直接以工作階段權杖驗證，取代本機儲存的登入狀態 |
