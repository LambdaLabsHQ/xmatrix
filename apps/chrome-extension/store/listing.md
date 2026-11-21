# Chrome Web Store listing

The text and answers to paste into the Chrome Web Store developer dashboard for the xMatrix extension. The publisher is the MadeByRobot, LLC developer account, declared as a trader. The images in this folder are the screenshots and the small promo tile. Their data is made up.

## Store listing

- **Name:** xMatrix (taken from the manifest)
- **Summary** (taken from the manifest's `description`, at most 132 characters): Send the page you are on, a link or selected text to a conversation in your xMatrix Space, and see what is waiting on you.
- **Category:** Productivity → Workflow & Planning
- **Language:** English
- **Homepage URL:** https://xmatrix.sh
- **Support URL:** https://xmatrix.sh/docs
- **Privacy policy URL:** https://xmatrix.sh/privacy

**Description**

```
xMatrix is where your team and coding agents such as Claude Code, Codex, Cursor and Gemini work together in shared conversations. This extension brings what you are looking at in Chrome into those conversations.

• Send a page, a link or selected text to any conversation in your Space, with a note. It is posted as you.
• Mention an Agent, for example @claude, to hand it the work: a bug report, a failing build, an incident page, a doc to update.
• The badge shows how many conversations are waiting on you.

How it works
• Sign in once on xmatrix.sh. The extension shows a code to compare, and no password is typed into it.
• The extension reads a page only when you click it, use its menu item or press its shortcut (Alt+Shift+X). Nothing is read in the background.
• Selected text is sent as a quote. Agents treat it as page content, not as instructions.

An xMatrix account is required: https://xmatrix.sh
```

## Privacy practices

**Single purpose**

```
Send the page, link or text the user chooses to a conversation in their xMatrix Space, and show how many conversations are waiting on them.
```

**Permission justifications**

| Permission | Justification |
| --- | --- |
| `activeTab` | Reads the title, address and selected text of the current tab only when the user opens the extension or uses its shortcut, so they can send it to a conversation. |
| `scripting` | Runs one function in the active tab, after the user clicked the extension, to read the text they selected. No code is injected otherwise. |
| `contextMenus` | Adds "Send page / selection / link to xMatrix" to the right-click menu. |
| `storage` | Keeps the user's xMatrix sign-in and the last conversation they sent to, on this device. |
| `alarms` | Refreshes the badge count once a minute, and keeps checking for the sign-in approval while the user approves it in a tab. |
| Host `https://xmatrix-hub.xmatrix.sh/*` | The xMatrix server the extension signs in to, lists conversations from and sends messages to. It is the only host the extension contacts. |

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
