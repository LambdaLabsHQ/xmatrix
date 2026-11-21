# xMatrix Chrome extension

A Manifest V3 extension that brings what a person is looking at in Chrome into their xMatrix Space.

- **Send to a conversation.** The toolbar button (Alt+Shift+X) and the context menu items *Send page / selection / link to xMatrix* open a popup. There the person picks a Space and a conversation, adds a note (mentioning an Agent such as `@claude` hands it the work), and sends. The message is posted as the person. It has the note, a link to the page and, if text was selected, the selection as a quote.
- **Needs you badge.** Once a minute the badge shows how many conversations are waiting on the person. This is the same `attention` count as the web's "Needs you" section.

## How it talks to the Hub

- **Sign-in** uses the CLI's device flow: `POST /api/auth/cli/device/start`, the person approves `verificationUriComplete` in a browser tab, then the service worker polls `POST /api/auth/cli/device/token`. The session (a one-hour access token and its 30-day refresh token) is kept in `chrome.storage.local`, which only the extension can read. *Sign out* revokes it with `POST /api/auth/cli/sign-out`.
- **Every Hub call runs in the service worker** (`src/background.js`). A single queue there renews the access token through `POST /api/auth/refresh`, so the popup and the badge never renew at the same time. The popup's runtime messages are accepted only from the extension's own pages.
- **Client identity.** Requests declare `component: app`, `platform: chrome-extension`, protocol 2 and the manifest version, so the Hub's compatibility gate admits them. When the app minimum version rises, the extension needs a release at or above it.
- **Sending** uses `POST /api/channels/:channelId/messages` with `{ body, clientMessageId, launch: true }`, as the web composer does.
- **Listing** uses `GET /api/spaces` and `GET /api/channels?spaceId=…`. The badge reads `GET /api/channels`.

## Privacy and permissions

- **Reading pages.** The extension reads a page only when the person clicks it: through `activeTab`, the context menu, or the keyboard shortcut. Nothing is read in the background.
- **Host access.** Its only host permission is the production Hub.
- **Page text.** Text taken from a page is sent as a quoted excerpt. Agents treat it like any other message content: it is untrusted input, never an instruction (guardrail P0#2).

## Develop

```sh
pnpm --filter @xmatrix/chrome-extension test      # unit tests
pnpm --filter @xmatrix/chrome-extension package   # dist/chrome-extension, version stamped from version.json
```

To try it, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and select `apps/chrome-extension`, or the packaged `dist/chrome-extension`.

## Not done yet

- **Chrome Web Store.** No listing or publish workflow yet. The listing has to be created in a developer account first.
- **Save to Page** is not built yet.
- **Attachments.** Full-page snapshots as attachments are not supported.
