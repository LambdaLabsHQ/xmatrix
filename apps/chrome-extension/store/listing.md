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
Chat with your agents about any webpage. xMatrix is where your team and coding agents such as Claude Code, Codex, Cursor and Gemini work together; this extension keeps the conversation about the page you are reading in Chrome's side panel, next to it.

• Select text and ask about it right there: the question box opens under the selection. Your question starts a conversation in the side panel, with the passage and a link back to the page, and an Agent in your Space picks it up.
• Or ask about the whole page: its text goes with your question as a file you can remove, so an Agent can read pages behind your sign-in.
• Asking again on the same page continues its conversation. Switch tabs and the panel shows that page's conversation; Recent brings back earlier ones.
• Mention an Agent, for example @claude, to hand the work to that one: a bug report, an incident page, a doc to update.
• Replies, progress and approval cards stay live in the panel while you browse; the full xMatrix app is one click away.

How it works
• Sign in once on xmatrix.page. The extension shows a code to compare, and no password is typed into it.
• By default the extension reads a page only when you use its menu item or its side panel: "Ask about this page" reads that page's text to attach it. The optional question box under selected text asks for access to web pages first, and even then reads only the text you select, and sends it only with a question you send.
• Selected text is sent as a quote. Agents treat it as page content, not as instructions.

An xMatrix account is required: https://xmatrix.page
```

## Privacy practices

**Single purpose**

```
Open the user's xMatrix workspace in the side panel, beside the page they are reading, so they can discuss that page or text they select on it with their team and AI agents.
```

**Permission justifications**

| Permission | Justification |
| --- | --- |
| `sidePanel` | The extension's interface is the xMatrix workspace in Chrome's side panel. |
| `activeTab` | Reads the title, address and selected text of the current tab only when the user uses the extension's menu item or panel button, so they can ask about it. |
| `scripting` | After the user acted, opens the question box in that tab or reads the text they selected; and registers the optional box beside selected text once the user grants web-page access. |
| `contextMenus` | Adds "Ask about “selection”" and "Ask about this page" to the right-click menu. |
| `storage` | Keeps the user's xMatrix sign-in on this device, and text they picked until the panel takes it. |
| `alarms` | Keeps checking for the sign-in approval while the user approves it in a tab. |
| Host `https://xmatrix-hub.xmatrix.sh/*` | The xMatrix server. The extension signs in to it, starts the conversations the user asks on a page, and the workspace in the side panel reads and sends the user's conversations through it. |
| Optional hosts `https://*/*`, `http://*/*` | Requested only when the user turns it on, right after signing in: shows the question box under text they select on a page, holding that text. It reads only the selected text, and sends it only with a question the user sends. |

**Remote code:** No. All code ships in the package, the workspace shown in the side panel included: it is built into the package, not loaded from a website. The package's content security policy allows scripts from the package only.

**Data usage.** Check these boxes:
- Personally identifiable information: the account name returned at sign-in.
- Authentication information: the session token.
- Website content: the page title, address, selected text, and (when the user asks about a whole page) the page text, sent only with a question the user sends.

Certify all three:
- Not sold to third parties.
- Not used or transferred for purposes unrelated to the single purpose.
- Not used to determine creditworthiness or for lending.

## Distribution

- **Visibility:** Public
- **Regions:** All regions

## Package

Build the upload with `pnpm --filter @xmatrix/chrome-extension package` (after `pnpm --filter @xmatrix/protocol build`). Zip the contents of `dist/chrome-extension` with `manifest.json` at the root of the zip.
