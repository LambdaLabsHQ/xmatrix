# Chrome Web Store listing

The text and answers to paste into the Chrome Web Store developer dashboard for the xMatrix extension. The publisher is the MadeByRobot, LLC developer account, declared as a trader. The images in this folder are the screenshots and the small promo tile; they still show the earlier popup and are re-taken from the side panel before the next submission. Their data is made up.

## Store listing

- **Name:** xMatrix (taken from the manifest)
- **Summary** (taken from the manifest's `description`, at most 132 characters): Your xMatrix Space beside every page: discuss what you are reading with your team and Agents.
- **Category:** Productivity → Workflow & Planning
- **Language:** English
- **Homepage URL:** https://xmatrix.page
- **Support URL:** https://xmatrix.page/docs
- **Privacy policy URL:** https://xmatrix.page/privacy

**Description**

```
Chat with your agents about any webpage. xMatrix is where your team and coding agents such as Claude Code, Codex, Cursor and Gemini work together; this extension keeps the conversation about the page you are reading right beside it, on the page or in Chrome's side panel.

• Select text and ask about it right there: the question box opens under the selection and expands directly into a live conversation card on the page, with the passage and a link back to the page, while an Agent in your Space picks it up.
• Dock or expand anytime: minimize the card to a quiet tab on the right edge, or click to move the same live conversation into Chrome's side panel without reloading.
• Or ask about the whole page: the side panel opens a conversation about the page beside it, and an Agent reads the page as you see it, even behind your sign-in.
• One conversation per tab: whichever conversation you open in a tab's side panel or inline card stays bound to that tab as you browse, and Recent brings back earlier ones.
• Your Agents see the page too: what you write in the card or side panel says which page you are on, and an Agent can read that page. Another tab you have open is read only after you allow it in the side panel. The extension never opens a page for an Agent.
• Approvals stay protected in the side panel: confirmations, choices, secrets, and connector approvals appear read-only in the on-page card and open Chrome's side panel so you decide safely outside the webpage.
• Mention an Agent, for example @claude, to hand the work to that one: a bug report, an incident page, a doc to update.

How it works
• Sign in once by approving the sign-in in a browser tab. The extension shows a code to compare, and no password is typed into it.
• By default the extension reads a page only when you use its menu item or its side panel, or an Agent you are talking to reads the page bound to that tab. The optional question box under selected text asks for access to web pages first, and even then reads only the text you select, and sends it only with a question you send.
• If you close or navigate away from a page right after sending a question, the extension temporarily holds the unsent message in local extension storage (deleted immediately once delivered, or after at most 10 minutes; a brief delivery-failure notice is kept for at most 24 hours unless dismissed) so slow networks never drop your question.
• Selected text is sent as a quote. Agents treat it as page content, not as instructions.

An xMatrix account is required: https://xmatrix.page
```

## Privacy practices

**Single purpose**

```
Let the user discuss the webpage or text they select on it with their team and AI agents—directly in an on-page conversation card or in Chrome's side panel.
```

**Permission justifications**

| Permission | Justification |
| --- | --- |
| `sidePanel` | Hosts the xMatrix conversation workspace in Chrome's side panel beside the user's tab, and handles approval cards safely outside web pages. |
| `activeTab` | Reads the title, address and selected text of the current tab only when the user uses the extension's menu item or panel button, so they can ask about it. |
| `scripting` | After the user acted, opens the question box and inline conversation card in that tab or reads the text they selected; and registers the optional box beside selected text once the user grants web-page access. |
| `contextMenus` | Adds "Ask about “selection”" and "Ask about this page" to the right-click menu. |
| `storage` | Keeps the user's xMatrix sign-in on this device, which conversation is bound to each open tab, text picked until the panel takes it, and an ephemeral outbox for unsent questions (deleted once delivered or after at most 10 minutes; undelivered failure notices kept up to 24 hours unless dismissed). |
| `alarms` | Keeps checking for the sign-in approval while the user approves it in a tab, and wakes the service worker to finish delivering any unsent outbox message if the user leaves the page on a slow network. |
| Host `https://xmatrix-hub.xmatrix.sh/*` | The xMatrix server. The extension signs in to it, starts the conversations the user asks on a page, finishes delivery if the tab closes mid-send, and reads and sends the user's conversations through it. |
| Optional hosts `https://*/*`, `http://*/*` | Requested only when the user turns it on, right after signing in: shows the question box and inline conversation card under text they select on a page, holding that text. It reads only the selected text, and sends it only with a question the user sends. |

**Remote code:** No. All code ships in the package, the workspace shown in the inline card and side panel included: it is built into the package, not loaded from a website. The package's content security policy allows scripts from the package only.

**Data usage.** Check these boxes:
- Personally identifiable information: the account name returned at sign-in.
- Authentication information: the session token.
- Website content: the page title, address and selected text, sent only with a question the user sends (held locally in extension storage while in transit for at most 10 minutes if the user leaves the page mid-send, deleted once delivered; a brief undelivered notice is kept up to 24 hours unless dismissed); the title and address of the page beside the card or side panel, with each message the user writes there (the user can take it off); and, for a tab bound to a conversation or with an open side panel, the accessibility snapshot (visible text, headings, links, form fields) of a page an Agent in the user's conversation reads: that bound tab's page, or another open tab the user explicitly allows in the side panel. It goes to that Agent only and is not stored.

Certify all three:
- Not sold to third parties.
- Not used or transferred for purposes unrelated to the single purpose.
- Not used to determine creditworthiness or for lending.

## Distribution

- **Visibility:** Public
- **Regions:** All regions

## Package

Build the upload with `pnpm --filter @xmatrix/chrome-extension package` (after `pnpm --filter @xmatrix/protocol build`). Zip the contents of `dist/chrome-extension` with `manifest.json` at the root of the zip.
