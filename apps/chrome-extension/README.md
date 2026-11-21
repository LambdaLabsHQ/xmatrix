# xMatrix Chrome extension

A Manifest V3 extension that puts the person's xMatrix Space in Chrome's side panel, beside the page they are reading. The extension is about the moments when someone is actively browsing. Browser automation is out of scope: Playwright already covers it without an extension.

- **The app beside every page.** The toolbar button (Alt+Shift+X) opens the side panel. The panel is the real web app (`https://xmatrix.sh/app`; the beta Web for an unpacked build) in a frame, with a narrow-screen layout: live conversations, mentions, Agents, approval cards and Pages.
- **Discuss what you are reading.** Select text and choose one of two actions. *Discuss* starts a new conversation named by the passage. *Quote* adds the passage to the open conversation. In both cases the composer holds the passage as a quote with a link back to the page. Both actions are available from the context menu (*Discuss in xMatrix* also works on a whole page or a link), from the bar at the top of the panel (*Quote* / *New chat* for the page beside it), and, once the person turns it on, from a small button next to the selection.
- **Needs you badge.** The badge counts the conversations waiting on the person. It is the same `attention` count as the web's "Needs you" section.

## How it fits together

- **Sign-in.** The extension uses the CLI's device flow: `POST /api/auth/cli/device/start`, the person approves in a browser tab, then the service worker polls `/api/auth/cli/device/token`. The session (a one-hour access token and a 30-day refresh token) stays in `chrome.storage.local`.
- **Embedding.** A frame in an extension page gets none of the site's cookies, so the panel cannot use the browser's web session. The embedded app asks for a token over `postMessage` (`apps/web/src/lib/extension-embed.ts`). The panel replies with a current access token, which the service worker renews when it has under ten minutes left. The refresh token never reaches the page.
  - Both sides check every message: the panel answers only `https://xmatrix.sh` in its own frame, and the app answers only this extension's origin.
  - Only this extension may frame the app (CSP `frame-ancestors`, `apps/web/src/lib/extension-embed-origins.ts`).
  - Signing out in either place signs out both.
- **Extension ID.** `manifest.json` carries the Chrome Web Store item's public `key`, so an unpacked build has the store ID `kaickfjmldmlelnfijaahialjpnebnak`. That is the ID the web app allows. `scripts/package.mjs` removes the key from the store upload.
- **Passages.** Passages are queued in `chrome.storage.session` until the app reports `ready`, then delivered as `{ type: "passage", text, label, href, target }`. The app quotes them through its existing passage-discussion path.
- **Client identity.** Requests declare `component: app` and `platform: chrome-extension`, so the Hub's compatibility gate admits them.

## Permissions

- **At install:**
  - `sidePanel`, `storage`, `alarms` and `contextMenus`.
  - `activeTab` and `scripting`, to read the selected text of the page the person acted on.
  - Host access to the Hub only.
- **Quick select (optional):** the button beside selected text needs access to web pages, `https://*/*` and `http://*/*`. That access is requested only when the person clicks *Turn on* in the panel. The extension then registers `src/selection.js`, which reads nothing until the person clicks the button, and then only the selected text. Without that access, the context menu and the panel bar still work.

## Develop

```sh
pnpm --filter @xmatrix/chrome-extension test
pnpm --filter @xmatrix/chrome-extension package   # dist/chrome-extension; --release X.Y.Z to override version.json
```

To load it, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and select `apps/chrome-extension`. The unpacked build opens the beta Web (`https://beta.xmatrix.sh/app`), where Web changes land first. The store build, packaged without the key, opens `https://xmatrix.sh/app`.
