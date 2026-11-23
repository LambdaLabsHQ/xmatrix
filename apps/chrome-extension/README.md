# xMatrix Chrome extension

A Manifest V3 extension that puts the person's xMatrix Space in Chrome's side panel, beside the page they are reading. The extension is about the moments when someone is actively browsing. Browser automation is out of scope: Playwright already covers it without an extension.

- **The companion of the page beside it.** The toolbar button (Alt+Shift+X) opens the side panel. The panel is the real workspace app, built from `apps/web` into the extension's own package, in its companion mode (`useExtensionCompanion`): it shows the conversation about the page beside it and nothing else of the workspace (no dock, lists, Pages or search). Its bar names the conversation and the Space it asks in (tap to switch), and holds Recent (the last conversations started from the extension), + (a new conversation about this page) and the open conversation in the full app. Switching tabs brings that page's conversation into view; a page without one leaves the open conversation in place, and + asks about it. With no conversation open, the panel opens a new one about the page.
- **Ask about this page.** The new conversation opens with the page quoted and its readable text (the main article, at most 200,000 characters) attached as a file that can be removed. The panel reads that text only when the person asks about the page: + , or opening the panel on a page with no conversation.
- **Agents see and read the page (`xmatrix browse`).** Each message written in the side panel carries the page beside it (`browserPage` message metadata, `packages/protocol/src/browser-page.ts`): the conversation shows it under the message, and an Agent's runtime tells the Agent which page it is. `xmatrix browse` reads that page, the one beside the panel, with no prompt (Daniel 2026-11-23: chatting about it there is showing it); `--conversation` reads the page the conversation was started from, if a tab still shows it; `--tab <address>` reads another open tab only after the person allows it in the app's dialog (`BrowserReadApprovalDialog`). It never opens a page. The Hub (`packages/hub/src/browser-read.ts`) sends the request only to the person's side panel connections (capability `browser_read_v1`) and holds the Agent's call up to 90 seconds; with no side panel open the Agent is told at once. The service worker posts the text, or why it was not read, to `POST /api/browser/read/:id/answer`; the first open panel to claim a request answers it. Nothing is stored.
- **Ask right on the page.** One action, everywhere: ask. As soon as the person selects text, the App's conversation composer opens under the selection, as a new conversation has it, holding only the question: the selection is the quote (Daniel 2026-11-23), so the box shows no quote card. It asks in the Space the side panel shows. It does not take the focus, so the selection can still be copied; a click goes into it. It is the App's own `Composer`, not a copy: the page frames `app/ask.html`, built from `apps/web/src/extension-app/ask.tsx` with the side panel's app. Press Enter: the message opens with the passage quoted, as the App opens a discussion of a passage, then the question and the Agents picked with `@`, and the extension starts the conversation through the Hub itself, so nothing waits for the side panel's app to load. Nobody needs to be mentioned: the Space's routing picks an Agent, as for any message. The side panel then opens on that conversation. Asking again on the same page (its address without the fragment) follows up in that conversation; a question on another page, or in another Space, starts a new one.
  - The right-click menu has *Ask about “…”* for a selection and *Ask about this page*: it opens the same box on the page (activeTab), with no access to web pages granted.
  - Right after signing in, the panel asks once whether to turn on the field beside selections (it needs access to web pages). *Not now* goes straight to the app; the right-click menu works either way.

## How it fits together

- **Sign-in.** The extension uses the CLI's device flow: `POST /api/auth/cli/device/start`, the person approves in a browser tab, then the service worker polls `/api/auth/cli/device/token`. The session (a one-hour access token, a 30-day refresh token and the account it belongs to) stays in `chrome.storage.local`.
- **The packaged app.** `scripts/build-app.mjs` bundles `apps/web/src/extension-app/main.tsx` with esbuild: the Web's own providers, preparation gate and workspace shell, compiled with the same React Compiler pass, and the Web's stylesheet built by Tailwind. It is the Web's source, not a second interface.
  - The few Next modules the shell imports (`next/navigation`, `next/link`, `next/image`, `next/dynamic`) resolve to small modules in `apps/web/src/extension-app`. Importing anything else of Next fails the build.
  - The Web's Hub proxy routes (`apps/web/src/app/api/xmatrix`) are bundled as they are and answer in the page: `fetch` to the page's own `/api` is matched to its route as Next matches it, and the route sends the request to the Hub (`local-api.ts`, `hub-proxy.ts`). Routes that need the Web's server (its session cookies) are left out and answer 404.
  - The page is one file. The shell keeps its address (`/app/<space>/...`) with `history`; `navigation.ts` decides every navigation that would load another document: an app address is shown in place, a reload returns to the same address, any other link opens in a tab.
  - The Web's public files the app names (fonts, the wood texture, Agent and connector marks) are copied to the same paths at the package root.
- **The panel and the app.** The side panel page frames the packaged app and hands it the session over `postMessage` (`apps/web/src/lib/extension-embed.ts`): a current access token, which the service worker renews when it has under ten minutes left, and the account, so the app opens without first reading it from the Hub. The refresh token never reaches the page.
  - Both sides check every message: the panel answers only its own frame at the extension's origin, and the app is the panel's app only in a page of this extension that this extension frames.
  - The Web itself allows no page to frame it (CSP `frame-ancestors 'none'`).
  - Signing out in either place signs out both. When the Hub no longer admits the packaged app's version, the panel asks for the extension to be updated.
- **Content policy.** The manifest's `content_security_policy` (written by `scripts/package.mjs`) is the Web's policy without the Web: scripts, styles and fonts from the package only, requests to the Hub only, and pictures from the package, the Hub or the Web. A message that names a picture by address cannot make the reader's browser ask that address.
- **Extension ID.** `manifest.json` carries the Chrome Web Store item's public `key`, so an unpacked build has the store ID `kaickfjmldmlelnfijaahialjpnebnak`, the one the app takes as its side panel (`apps/web/src/lib/extension-embed-origins.ts`). The store upload is packaged without the key.
- **The Space.** The app tells the panel which Space it shows (`{ type: "space" }`); questions asked on a page go there.
- **The question box.** `src/selection.js` draws nothing itself: it hands the service worker the selected text (kept per tab in `chrome.storage.session`, in this browser), frames `app/ask.html` under the selection, and places, sizes and hides the frame as the frame asks; a click on the page or a scroll hides it. The frame reads its passage, session and Space from the service worker over `chrome.runtime`, never from the page. Its stylesheet, `ask.css`, is the App's with width queries and viewport units settled at a desktop window (`desktopStylesheet` in `scripts/build-app.mjs`): the frame is only as wide as the box, and would otherwise get the phone layout.
- **Passages.** Passages are queued in `chrome.storage.session` until the app reports `ready`, then delivered as `{ type: "passage", text, label, href, target }`. The app quotes them through its existing passage-discussion path.
- **Client identity.** Requests declare `component: app` and `platform: chrome-extension`, with the release the package was built for, so the Hub's compatibility gate admits them. A Hub that raises the app's minimum version needs a newer extension.

## Permissions

- **At install:**
  - `sidePanel`, `storage`, `alarms` and `contextMenus`.
  - `activeTab` and `scripting`, to read the selected text of the page the person acted on.
  - Host access to the Hub only.
- **Ask beside selections (optional):** the field beside selected text needs access to web pages, `https://*/*` and `http://*/*`. That access is requested only when the person clicks *Turn on* on the panel's screen after sign-in. The extension then registers `src/selection.js`, which reads only the selected text, and sends it only with a question the person sends. Without that access, the context menu injects the same script into the one tab it was used on.

## Develop

```sh
pnpm --filter @xmatrix/protocol build                         # once: the app imports the built protocol
pnpm --filter @xmatrix/chrome-extension test                  # unit tests, and a build of the whole package
pnpm --filter @xmatrix/chrome-extension package --unpacked    # dist/chrome-extension-unpacked, to load in Chrome
pnpm --filter @xmatrix/chrome-extension package               # dist/chrome-extension, the Chrome Web Store upload
```

`--release X.Y.Z` overrides `version.json`, for an upload that must exceed the last one. `--hub <url>` builds for another Hub (a local `pnpm dev:stack`): the service worker, the app and the content policy all follow it.

To load it, build with `--unpacked`, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and select `dist/chrome-extension-unpacked`. After a rebuild, click the extension's reload button there. The source directory itself is not loadable: the app is built into the package.
