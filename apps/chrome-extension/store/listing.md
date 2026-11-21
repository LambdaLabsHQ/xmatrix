# Chrome Web Store listing

The text and answers to paste into the Chrome Web Store developer dashboard for the xMatrix extension. The publisher is the MadeByRobot, LLC developer account, declared as a trader. The images in this folder are the screenshots and the small promo tile; they still show the earlier popup and are re-taken from the side panel once the Web change that lets it embed the app is live. Their data is made up.

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
Your xMatrix Space beside every page. xMatrix is where your team and coding agents such as Claude Code, Codex, Cursor and Gemini work together in shared conversations; this extension opens it in Chrome's side panel, next to whatever you are reading.

• Select text and Discuss: start a conversation about it with your team and Agents, holding the passage and a link back to the page.
• Or Quote it into the conversation you have open.
• Mention an Agent, for example @claude, to hand it the work: a bug report, an incident page, a doc to update.
• Your conversations, Agents, approvals and Pages stay live in the panel while you browse. The badge shows how many conversations are waiting on you.

How it works
• Sign in once on xmatrix.page. The extension shows a code to compare, and no password is typed into it.
• By default the extension reads a page only when you use its menu item, its panel buttons or its shortcut (Alt+Shift+X). The optional quick-select button beside selected text asks for access to web pages first, and even then reads only the text you selected, when you click it.
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
| `activeTab` | Reads the title, address and selected text of the current tab only when the user uses the extension's menu item, panel button or shortcut, so they can discuss it. |
| `scripting` | Runs one function in the active tab, after the user acted, to read the text they selected; and registers the optional quick-select button once the user grants web-page access. |
| `contextMenus` | Adds "Discuss in xMatrix" and "Quote in the open xMatrix conversation" to the right-click menu. |
| `storage` | Keeps the user's xMatrix sign-in on this device, and text they picked until the panel takes it. |
| `alarms` | Refreshes the badge count once a minute, and keeps checking for the sign-in approval while the user approves it in a tab. |
| Host `https://xmatrix-hub.xmatrix.sh/*` | The xMatrix server the extension signs in to and reads the badge count from. |
| Optional hosts `https://*/*`, `http://*/*` | Requested only when the user turns on quick select: shows a small button beside text they select on a page. The button reads only the selected text, and only when clicked. |

**Remote code:** No. All code ships in the package.

**Data usage.** Check these boxes:
- Personally identifiable information: the account name returned at sign-in.
- Authentication information: the session token.
- Website content: the page title, address and selected text, sent only when the user chooses to.

Certify all three:
- Not sold to third parties.
- Not used or transferred for purposes unrelated to the single purpose.
- Not used to determine creditworthiness or for lending.

## Distribution

- **Visibility:** Public
- **Regions:** All regions

## Package

Build the upload with `pnpm --filter @xmatrix/chrome-extension package`. Zip the contents of `dist/chrome-extension` with `manifest.json` at the root of the zip.
