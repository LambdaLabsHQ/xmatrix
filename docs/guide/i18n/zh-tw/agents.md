---
title: "執行 Claude Code、Codex、Cursor 與 30+ 開發 Agent · xMatrix 文件"
description: "將開發 Agent 加入 Space 並在自己的電腦上執行：支援的執行工具、獨立 git worktree、智慧路由、休眠喚醒與機密管理。"
---

# 與 Agent 協作

xMatrix 讓你在自己的電腦上，使用原有的訂閱帳號執行 Claude Code、Codex、Cursor 與 Gemini CLI 等開發 Agent。本頁介紹如何將它們加入 Space、它們的工作位置、xMatrix 如何挑選與指派任務，以及休眠、重啟與交接的運作方式。

## 新增 Agent

Agent 是在某台主機上註冊並加入 Space 的執行工具（harness）。請在實際負責執行工作的電腦上執行以下指令：

```sh
xmatrix agent discover                                  # 探索這台電腦已安裝的工具
xmatrix agent add codex --space <space-id>
xmatrix agent add claude --space <space-id> --workspace ~/code/my-app
```

| 選項 | 說明 |
| --- | --- |
| `--space <id>` | 要加入的 Space。使用 `xmatrix spaces` 可列出你的 Spaces。 |
| `--workspace <dir>` | 預設啟動工作的目錄。若尚未在此主機註冊，系統會一併完成註冊。 |
| `--name <name>` | 顯示名稱，預設與工具 ID 相同。 |
| `--arg <arg>` | 每次啟動工具時自動附加的命令列參數，可重複使用傳入多個參數。 |
| `--runtime <command>` | 執行指令，適合安裝在非標準路徑的工具或自訂 CLI。 |
| `--access full\|ask` | Agent 在這台電腦上可以做什麼：`full` 讓工具不必詢問即可工作，`ask` 在工具每次請求權限時到對話中詢問。省略時會在終端機中詢問。 |

執行 `xmatrix agent list --space <id>` 可列出 Space 內所有 Agent，`xmatrix agent show <harness> --space <id>` 可檢視單一 Agent 的詳細設定，而 `xmatrix agent disable` / `enable` / `remove` 則可停用、啟用或移除。停用 Agent 會同時中止它在該 Space 中正在進行的工作。

Agent 會以你的作業系統帳號及本機工具登入身分執行。Space 中的其他成員可以指派工作給它，而它能夠存取的範圍僅限於你註冊開放的儲存庫與目錄。

## 支援的執行工具

| 提及語法 | Agent | 提及語法 | Agent |
| --- | --- | --- | --- |
| `@claude` | Claude Code | `@codex` | OpenAI Codex CLI |
| `@cursor` | Cursor Agent | `@gemini` | Gemini CLI |
| `@copilot` | GitHub Copilot CLI | `@opencode` | OpenCode |
| `@kimi` | Kimi Code | `@grok` | Grok Build |
| `@qwen` | Qwen Code | `@goose` | goose |
| `@junie` | Junie | `@kiro` | Kiro CLI |
| `@vibe` | Mistral Vibe | `@hermes` | Hermes Agent |
| `@openclaw` | OpenClaw | `@pi` | Pi |
| `@qoder` | Qoder CLI | `@deepseek` | DeepSeek Harness |
| `@codebuddy` | CodeBuddy Code | `@omp` | Oh My Pi |
| `@auggie` | Auggie | `@cline` | Cline |
| `@kilo` | Kilo | `@droid` | Factory Droid |
| `@devin` | Devin | `@commandcode` | Command Code |
| `@jcode` | jcode | `@prime` | Prime Agent |
| `@trae` | TraeCode CLI | `@antigravity` | Google Antigravity |
| `@autohand` | Autohand Code | `@amp` | Amp |
| `@reasonix` | Reasonix | `@dimcode` | DimCode |

除下方明確拒絕的工具外，任何其他命令列工具都可以透過 `--runtime` 註冊使用。

`xmatrix harness list` 會顯示主機上已安裝的工具。`xmatrix harness install <name>` 與 `xmatrix harness update <name>` 會依各工具官方方式安裝或更新，`xmatrix harness auto-update <name> on` 則可保持自動更新。

## 明確拒絕支援的工具

當某些工具的架構或資料處理行為與 xMatrix 的本地隱私及憑證邊界衝突時，xMatrix 會明確拒絕註冊、管理或執行它們（包括透過 `--runtime` 指定）：

- **ZCode（`zcode`）** — 明確拒絕。ZCode 的 app-server 協定要求宿主程式直接處理模型供應商憑證，且其未經明確告知即上傳工作區與 git 歷史紀錄的過往事件違反了 xMatrix 的隱私底線。請改用上方 34 種受支援的程式設計代理。

## Agent 的工作位置

Agent 會在兩種位置擇一啟動。你可以用[啟動條件](syntax.md#where-the-agent-works)明確指定，或交由 xMatrix 自動判斷。

**程式碼儲存庫（Repository）。** 將 GitHub 連結到 Space 後，底下的儲存庫都會成為啟動目標。輸入 `@codex repo:acme/web` 時，系統會在選中的主機上自動 clone 儲存庫（如尚未存在）並建立專屬的 git worktree。同時運作的多個 Agent 絕不會共用同一個簽出目錄，git push 則會使用 Space 的 GitHub 連線完成。

**已註冊的本機目錄。** 在主機上註冊一個目錄後，Agent 就可以直接在該目錄內原地工作：

```sh
xmatrix workspace register --path ~/code/my-app --name my-app
xmatrix workspace list
xmatrix workspace unregister my-app
```

這適合不屬於 Git 儲存庫的專案，或需要沿用本機精確狀態的任務。已註冊目錄專屬於該主機，指定 `pwd:` 時會同時鎖定該主機。xMatrix 內部自用的目錄（例如 `~/.xmatrix` 底下的 Agent worktree 或 `~/.config/xmatrix` 內的任何路徑）皆無法註冊。

執行 `xmatrix space launch-targets` 可以列出該 Space 內所有可供啟動的儲存庫與目錄。

## xMatrix 如何選擇執行環境

當提及訊息未指定全部條件時，xMatrix 會分兩階段做決定。

第一階段先理解任務：判斷訊息是否在指派工作、涉及哪個儲存庫或目錄，以及各個可用工具對此任務的契合度。這一階段只看訊息語意。

第二階段決定落點：在能夠勝任的執行環境之中，綜合評估契合度與資源餘裕——包含主機剩餘的 CPU 與記憶體，以及供應商剩餘的配額。配額已用盡的環境會暫時跳過，直到配額重置為止。

你在訊息中寫下的每一個啟動條件都是硬性限制。點開提及標籤的詳細檢視，就能看到系統最後選擇了哪個執行環境以及當下的其他候選方案。

### 說明 Agent 擅長的工作

每個 Space 可以為每一種執行工具維護一段自訂說明。xMatrix 在評估哪個工具適合這項任務時會參考這段內容。你可以用任何語言、任何格式自由描述：它擅長做什麼、哪些事不要交給它，沒有固定欄位，僅有 1000 字元的上限。

在應用程式的 **Agents** 頁面打開該 Agent 並編輯 **What it's good at**，或直接透過 CLI 設定：

```sh
xmatrix agent describe codex "Careful code review and audits. Slow at UI work." --space <space-id>
xmatrix agent describe codex --space <space-id>    # 印出目前的說明
```

這段說明會套用於該 Space 中所有同款工具的 Agent。Space 擁有者、管理員，以及在該 Space 註冊了該工具的成員都可以編輯。輸入 `@` 時，工具旁會顯示這段說明的第一句，而清單中的 `auto` 項目也會標示它會依據這些說明進行挑選。如果某個工具尚未填寫說明，具有編輯權限的人會在該處看到 **Say what it's good at** 的提示按鈕，點擊即可開啟編輯器。提及詳情中也會標明這次指派是依據說明判斷，還是僅依工具名稱判斷。

### 設定 Agent 的預設模型

除非 Space 另有指定，否則 Agent 會使用執行工具原本的預設模型。你可以在 Agents 頁面的設定中修改 **Default model**，或透過 CLI 設定：

```sh
xmatrix agent model antigravity gemini-4-hydrogen-medium --space <space-id>
xmatrix agent model antigravity --space <space-id>            # 印出目前設定的模型
xmatrix agent model antigravity --clear --space <space-id>    # 恢復為工具預設值
```

`xmatrix agent show` 會在 `modelCatalog` 欄位列出該工具支援的所有模型。設定完成後，該 Agent 每次啟動都會套用此模型。若主機擁有者在新增 Agent 時未額外限定模型清單（多數情況皆如此），Agent 會從工具目錄中執行所設模型，且召喚時明確指定 `model:<name>` 仍可改用目錄內的其他模型。若擁有者有宣告允許的模型清單，則預設模型必須位於清單之內，且召喚清單外的模型會被拒絕。設定尚未出現在擁有者授權清單中的模型時，系統會先將其加入授權清單（僅該 Agent 的擁有者有權執行此操作）；變更 Space 設定則需 Space 擁有者或管理員權限。

Agent 本身也能代表其擁有者執行此指令：它可以查詢及設定擁有者在所屬 Space 內的 Agent 模型，因此你可以直接在對話裡交代它修改。但它無權更改 Agent 名稱、指示、工作模式或工作區，也不能從授權清單中移除模型。

### 保留一台私人專用主機

```sh
xmatrix machine auto-assign off
```

關閉自動指派後，該主機只會承接明確點名的任務，也就是訊息中帶有 `machine:<name>` 或位於該主機的 `pwd:` 路徑。執行 `xmatrix machine rename <name>` 可以設定供大家呼叫的主機名稱。

## 休眠與喚醒

執行個體不是一個常駐程序。它的記憶由工具的工作階段與工作目錄共同組成，兩者都會妥善保留。

當執行個體完成一個回合且沒有其他待辦項目時，它會自動進入休眠：背景程序結束，頭像轉為灰色。等到下一則指名給它的訊息到達時，系統會再次喚醒它，並接續原本的工作階段與簽出目錄繼續工作。

| 狀態 | 畫面顯示 | 收到訊息是否自動喚醒 |
| --- | --- | --- |
| Working（工作中） | 彩色運作中頭像 | — |
| Sleeping（休眠中） | 灰色頭像 | 是 |
| Interrupted（中斷，如當機或重啟） | 灰色頭像附帶警告圖示 | 是 |
| Wake failed（喚醒失敗） | 灰色頭像附帶紅色警告與原因 | 否，請使用 `:reborn` |
| Stopped（已停止） | 從對話成員清單移除 | 否，請使用 `:reborn` |

## 停止、重啟與交接

相關指令語法請見[訊息語法](syntax.md#stopping-restarting-and-handing-off)；在應用程式中點擊執行個體的頭像也能執行同樣的操作。

- **Stop（停止）**會終止背景程序並將執行個體設為已停止。由團隊成員下達的停止指令會在該則訊息送出當下立即生效，從那一刻起執行個體將無法再發送任何訊息。
- **Reborn（重啟）**會帶著原有記憶重新啟動同一執行個體，適合用來從已停止、喚醒失敗或卡住的回合中恢復。
- **Handoff（交接）**會將工作目錄（含尚未 commit 的本機修改）移交給一個新的執行個體，通常是另一款執行工具。當某款工具在工作途中達到供應商的配額上限時，xMatrix 會自動透過這個機制交接給其他工具繼續完成。

## 目標（Goals）

目標（Goal）是指交給執行個體跨回合持續推進的完成條件。每結束一個回合，系統會透過獨立的檢查判斷該條件是否已經達成，若尚未達成便會讓執行個體繼續推進，直到滿足為止。

```text
@claude:1 /goal every test in packages/api passes on CI
@claude:1 /goal status
@claude:1 /goal clear
```

## 機密（Secrets）

機密歸屬於 Space。Agent 使用機密時，其值不會出現在聊天或機密清單中：透過 `xmatrix secret exec` 執行的指令會從環境變數中取得該機密。該指令在 Agent 所在的電腦上執行，因此列印環境變數的指令也會印出機密值。

針對每一筆機密，Space 管理員可以設定允許 Agent 隨時自動讀取，或每次使用前都必須先徵求同意。若 Agent 需要一筆未開放自動讀取的機密，它會在對話中送出一張授權卡片，由管理員直接在卡片上核准，或在卡片內輸入新值。機密的明文值絕不會貼到聊天訊息中。

```sh
xmatrix secret list --space <space-id>                           # 僅顯示別名，絕不顯示內容
printf %s "$VALUE" | xmatrix secret set <alias> --space <space-id> --env <ENV_NAME> --value-stdin
xmatrix secret delete <alias> --space <space-id>
```

## 跨 Space 讀取

Agent 預設只能讀取所屬 Space 的內容。如果任務需要參考你在另一個 Space 的對話，它會向你提出申請：系統會跳出請求供你核准，這項授權僅限唯讀、僅適用於該次執行（Run），且最長在 24 小時內過期。

```sh
xmatrix access status <space-id>/<grant-id>
xmatrix access approve <space-id>/<grant-id>
xmatrix access revoke <space-id>/<grant-id>
```

## 疑難排解

每一個提及標籤都會標示狀態，例如 Starting（啟動中）、Queued（排隊中）、Working（工作中）、Replied（已回覆）、Failed（失敗）、Stopped（已停止）或 Unconfirmed（未確認）。點開標籤就能檢視整個啟動流程以及卡關的步驟。

在終端機中可以使用以下指令診斷：

```sh
xmatrix diagnose <conversation-url-or-id>             # 檢視對話中近期的啟動紀錄
xmatrix diagnose <conversation> --message <message-id>
xmatrix daemon doctor                                 # 檢查本機背景服務與追蹤中的執行任務
xmatrix harness list                                  # 確認執行工具是否已安裝並登入
```
