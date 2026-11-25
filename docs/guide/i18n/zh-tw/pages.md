---
title: "動態頁面與維持文件正確的程式 · xMatrix 文件"
description: "用 xMatrix 頁面讓專案文件隨時保持正確：人與 Agent 共同編輯的 Markdown 文件，以及依排程或事件自動執行 Agent 的 Norn 程式。"
---

# 頁面

對話節奏很快，事後往往難以回溯。頁面（Pages）用來保存一個 Space 當下真實有效的資訊：目前狀態、生效中的決策與尚未完成的工作。團隊成員在對話中討論，Agent 則隨著工作進展更新頁面。

## 頁面樹狀結構

每個 Space 擁有一棵頁面樹。請依照 Space 處理的主題或專案來分類，而不是依照「誰說了什麼」來分類。頁面本身就是 Markdown 文件，標題即為各個章節。無論頁面位於樹中的哪個位置，它的第一個頂層標題（`# 名稱`）就是頁面名稱；重新命名頁面會同步改寫該標題。

在應用程式中開啟 **Pages**，清單最上方會先顯示近期變動，接著呈現完整的樹狀結構。透過終端機也能操作：

```sh
xmatrix page tree
xmatrix page tree --summaries
xmatrix page search <words>
xmatrix page read <page-id>
xmatrix page create "Billing" --under <parent-page-id>
xmatrix page rename <page-id> "Billing and invoices"
xmatrix page move <page-id> --under <other-page-id>
xmatrix page delete <page-id>
```

`page tree --summaries` 會在每個頁面下方附上一行摘要說明目前進度。`page search` 會找出同時包含所有查詢詞的頁面，以 `page:<id>#<section>` 標示對應章節並顯示前後文；精確符合輸入順序的頁面會排在最前面。在大型 Space 中，先搜尋再讀取比逐一翻找頁面有效率得多。

## 閱讀與編輯

團隊成員可以在應用程式中多人即時協作編輯頁面，並看見彼此的游標。Agent 則透過 CLI 進行編輯，修改落實時會即時呈現在開啟的文件中。系統不會鎖定整份文件：每個章節都會顯示目前有誰正在編輯、有哪些 Agent 正在相關對話中作業，`xmatrix page read` 也會向 Agent 提供相同資訊。

透過 CLI 編輯時，會以先前讀取的版本號（revision）為基礎，提交新版 Markdown：

```sh
xmatrix page read <page-id>                       # 印出頁面內容與其版本號
xmatrix page edit <page-id> --base <revision> -f page.md
```

`--base` 應填入你原本讀取的版本號，而非強行改填最新版號。若這段期間有其他人修改了別處，xMatrix 會自動合併兩邊的變更；如果修改範圍重疊產生衝突，系統會拒絕寫入並回傳最新內容供你合併。

面對篇幅較長的頁面，不需讀取全文就能只修改單一章節：

```sh
xmatrix page read <page-id> --outline             # 檢視所有標題、對應 slug 與篇幅大小
xmatrix page read <page-id> --section <slug>      # 讀取單一章節（包含其子標題）
xmatrix page edit <page-id> --base <revision> --section <slug> -f section.md
```

章節編輯只會改寫該章節，並完整保留頁面其他區塊（包含你讀取後別人對他處所做的變更）。送出的內容需包含該章節的標題行。`page read --section` 印出的內容可以直接修改後原樣透過 `-f` 寫回：開頭標頭已註明章節身分，系統絕不會誤判為整頁覆寫。若要新增、刪除或調整章節順序，則請讀取並編輯整份頁面。

`xmatrix page read <page-id> --since <revision>` 只會印出該版本之後的變更，而 `xmatrix page history <page-id>` 則可列出歷史版本。

在應用程式中若想知道某段文字是誰寫的，只要將游標停留在該段落上，側邊欄就會顯示作者與時間。反白選取一段文字時，上方浮動提示也會顯示相同資訊，並附上撰寫該段文字時的來源對話；點擊即可在頁面旁開啟該對話，並定位到當時的訊息位置。尚未存檔、正在輸入中的文字則會顯示為「being written」。

### 什麼內容適合放在頁面上

頁面應該只呈現「現在為真」的狀態。請直接原地改寫內容，並移除已完成或已過時的項目，不要把頁面當作只增不減的流水帳日誌。Commit hash、執行 ID（run ID）與時間戳記等佐證資料請留在 Pull Request 與對話中，頁面只需附上連結即可。同一項事實只維護在一處，其他地方以連結參照。

## 頁面與對話的連動

當頁面與對話彼此參照時，兩者便會建立連結。已連結的頁面會以即時卡片的形式顯示在對話頂端，而在該對話啟動的 Agent 在開始工作前都會先閱讀這些頁面。

- 在訊息中輸入 `[[` 即可挑選頁面，輸入 `[[page#` 則可挑選特定章節。訊息會儲存為 `page:<page-id>` 或 `page:<page-id>#<heading-slug>`。
- 當 Agent 在執行過程中讀取某個頁面時，系統也會自動將該頁面連結至該對話。
- 使用 `xmatrix page link <page-id> --block <heading-slug>` 可明確建立連結，`xmatrix page linked` 則可列出目前對話連結了哪些頁面。
- 如果不想再讓某頁面的變動同步顯示在對話中，請將游標移至對話頂端的頁面卡片並選擇 **Unlink from this conversation**，或執行 `xmatrix page unlink <page-id>`。解除連結後，即使該對話中的 Agent 再次讀取或編輯該頁面，也不會自動重新連結，除非有人手動重新建立連結。

標題 slug 的產生規則與 GitHub 相同：將標題轉為小寫、空白改為連字號並移除標點符號，例如 `## Open work` 對應的 slug 就是 `open-work`。

### 段落討論（Discussions）

在頁面中選取一段文字即可發起討論，建立一個錨定在該段落上的專屬對話。討論得出結論後，請將結果寫回頁面並將討論標記為已解決（resolve）。

## 程式（Programs）

需要定期重複、等待特定日期，或在外部事件發生時自動啟動的工作，可以直接以程式區塊寫在頁面上：在需要維護的章節中插入標記為 `norn run` 加上名稱的程式碼區塊。程式採用 [Norn](https://norn-lang.org) 語言撰寫，儲存頁面後便會立即啟動。你可以像編輯頁面上任何一般文字一樣閱讀與修改它。

每 12 小時自動更新章節的 Agent 例行任務：

````markdown
## Open work

```norn run triage
open Std
routine(~every=12h, ~from=2026-11-16T09:00Z, ~who=@auto(~repo="acme/web"),
  ~otherwise=@claude(~repo="acme/web"),
  "Read the issues opened since the last run and update this section")
```
````

在指定日期發出提醒：

````markdown
```norn run renew-domain
after(2026-11-03T01:00Z)->wait
say(@alice, "Renew the domain this week")
```
````

每天定期巡檢，並在 CI 失敗時立即觸發修復：

````markdown
```norn run build-watch
open Std
routine(~every=1d, ~from=2026-11-16T09:00Z, ~on=ciFailed("acme/web"),
  ~who=@auto(~repo="acme/web"), ~otherwise=@claude(~repo="acme/web"),
  "Check the build and fix what is broken")
```
````

所有時間均採用 UTC。`~from` 指定首次執行的時間及後續循環節奏，`~who` 指定負責執行的 Agent，`~otherwise` 指定當某回合未能取得有效回覆時的備援對象。`~on` 則可在特定事件發生時追加執行，例如 `ciFailed("owner/repo")` 或 `prMerged("owner/repo")`。程式也能向團隊成員發問、設定截止時間等待回覆，以及在多個 Agent 之間交接任務。完整語法、請求型別、事件與限制請見[程式](programs.md)。

### 程式的運作方式

- 每個程式區塊都擁有專屬對話並連結至此頁面，所有請求、回覆與執行結果都會張貼在該對話中。
- 頁面會在區塊下方直接顯示程式的目前進度：已發出哪些請求與結果、現在正等待誰回覆，以及下一步將做什麼。若程式語法有誤無法執行，該處會顯示原因，`xmatrix page edit` 也會一併印出錯誤。
- 程式以最後儲存頁面的成員身分與權限執行；若由 Agent 儲存，則以該 Agent 擁有者的身分執行。
- 修改區塊內容即可調整程式，先前已發問過的請求不會重複詢問；移除該區塊即可停止程式。

```sh
xmatrix page read <page-id>     # 列出頁面上的程式與各自目前的執行狀態
```

## 公開頁面

Space 擁有者或管理員可以將頁面發布為公開頁面。發布後，任何人無需登入即可透過公開網址閱讀，且當 Agent 持續更新頁面時，讀者畫面也會即時同步更新。

只有對 Space 內所有成員都開放閱讀權限的頁面才能發布。發布父頁面並不會自動公開底下的子頁面。Agent 可以編輯公開頁面的內容，但只有團隊成員能決定發布或取消發布。
