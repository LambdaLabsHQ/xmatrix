# xMatrix Chrome extension

A Manifest V3 extension that puts the person's xMatrix Space in Chrome's side panel, beside the page they are reading. The extension is about the moments when someone is actively browsing. Browser automation is out of scope: Playwright already covers it without an extension.

- **The app beside every page.** The toolbar button (Alt+Shift+X) opens the side panel. The panel is the real workspace app, built from `apps/web` into the extension's own package, with its narrow-screen layout: live conversations, mentions, Agents, approval cards and Pages. Opening the panel loads nothing from the Web; the app's first requests go straight to the Hub.
- **Ask right on the page.** One action, everywhere: ask. Select text and the App's selection toolbar appears beside it with one item, *Ask*; a click opens the App's margin comment box there, asking in the Space the side panel shows. Both are the App's own components (`PaperPopover`, `PageCommentBox`), not copies: the page frames `app/ask.html`, built from `apps/web/src/extension-app/ask.tsx` with the side panel's app. Press Enter: the extension starts the conversation through the Hub itself, with the quoted passage and the question as its first message, so nothing waits for the side panel's app to load. Nobody needs to be mentioned: the Space's routing picks an Agent, as for any message (pick one with `@` to choose it). The side panel then opens on that conversation.
  - The right-click menu has *Ask about “…”* for a selection and *Ask about this page*: it opens the same box on the page (activeTab), with no access to web pages granted.
  - The bar at the top of the panel has *Ask about this page*, which starts a conversation about the page beside it in the app.
  - Right after signing in, the panel asks once whether to turn on the field beside selections (it needs access to web pages). *Not now* goes straight to the app; the right-click menu works either way.
- **Needs you badge.** The badge counts the conversations waiting on the person. It is the same `attention` count as the web's "Needs you" section.

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
- **The question box.** `src/selection.js` draws nothing itself: it frames `app/ask.html` beside the selection, places, sizes and hides the frame as the frame asks, and only when the person clicks *Ask* hands the service worker the selected text (kept per tab in `chrome.storage.session`). The frame reads its passage, session and Space from the service worker over `chrome.runtime`, never from the page. Its stylesheet, `ask.css`, is the App's with width queries and viewport units settled at a desktop window (`desktopStylesheet` in `scripts/build-app.mjs`): the frame is only as wide as the box, and would otherwise get the phone layout.
- **Passages.** Passages are queued in `chrome.storage.session` until the app reports `ready`, then delivered as `{ type: "passage", text, label, href, target }`. The app quotes them through its existing passage-discussion path.
- **Client identity.** Requests declare `component: app` and `platform: chrome-extension`, with the release the package was built for, so the Hub's compatibility gate admits them. A Hub that raises the app's minimum version needs a newer extension.

## Permissions

- **At install:**
  - `sidePanel`, `storage`, `alarms` and `contextMenus`.
  - `activeTab` and `scripting`, to read the selected text of the page the person acted on.
  - Host access to the Hub only.
- **Ask beside selections (optional):** the field beside selected text needs access to web pages, `https://*/*` and `http://*/*`. That access is requested only when the person clicks *Turn on* on the panel's screen after sign-in. The extension then registers `src/selection.js`, which reads nothing until the person clicks *Ask*, and then only the selected text. Without that access, the context menu injects the same script into the one tab it was used on.

## Develop

```sh
pnpm --filter @xmatrix/protocol build                         # once: the app imports the built protocol
pnpm --filter @xmatrix/chrome-extension test                  # unit tests, and a build of the whole package
pnpm --filter @xmatrix/chrome-extension package --unpacked    # dist/chrome-extension-unpacked, to load in Chrome
pnpm --filter @xmatrix/chrome-extension package               # dist/chrome-extension, the Chrome Web Store upload
```

`--release X.Y.Z` overrides `version.json`, for an upload that must exceed the last one. `--hub <url>` builds for another Hub (a local `pnpm dev:stack`): the service worker, the app and the content policy all follow it.

To load it, build with `--unpacked`, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and select `dist/chrome-extension-unpacked`. After a rebuild, click the extension's reload button there. The source directory itself is not loadable: the app is built into the package.
