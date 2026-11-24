import assert from "node:assert/strict";
import test from "node:test";

import { findTabForPage, isTrustedWebAppOrigin, pageKey, showWebPage } from "../src/page-tab.js";

function mockChrome({ tabs = [], session = {} } = {}) {
  const calls = { updatedTabs: [], focusedWindows: [], createdTabs: [] };
  const api = {
    tabs: {
      async get(id) {
        const found = tabs.find((tab) => tab.id === id);
        if (!found) throw new Error("No tab with id");
        return found;
      },
      async query() {
        return tabs;
      },
      async update(id, props) {
        calls.updatedTabs.push({ id, props });
        return { id, ...props };
      },
      async create(props) {
        calls.createdTabs.push(props);
        return { id: 999, ...props };
      },
    },
    windows: {
      async update(id, props) {
        calls.focusedWindows.push({ id, props });
        return { id, ...props };
      },
    },
    storage: {
      session: {
        async get() {
          return session;
        },
      },
    },
  };
  return { api, calls };
}

test("only xMatrix Web app origins are trusted for external tab-return messages", () => {
  assert.equal(isTrustedWebAppOrigin("https://xmatrix.sh"), true);
  assert.equal(isTrustedWebAppOrigin("https://beta.xmatrix.sh"), true);
  assert.equal(isTrustedWebAppOrigin("http://xmatrix.sh"), false);
  assert.equal(isTrustedWebAppOrigin("https://evil.xmatrix.sh"), false);
  assert.equal(isTrustedWebAppOrigin("https://xmatrix.sh.evil.example"), false);
  assert.equal(isTrustedWebAppOrigin("http://localhost:3000"), false);
  assert.equal(isTrustedWebAppOrigin("http://localhost:3000", { allowLocalhost: true }), true);
  assert.equal(isTrustedWebAppOrigin("http://127.0.0.1:4173", { allowLocalhost: true }), true);
  assert.equal(isTrustedWebAppOrigin("https://localhost:3000", { allowLocalhost: true }), false);
});

test("showWebPage prefers the panel's own tab, then another matching tab, and focuses its window", async () => {
  const { api, calls } = mockChrome({
    tabs: [
      { id: 1, windowId: 10, active: false, url: "https://x.com/daniel/status/1#reply" },
      { id: 2, windowId: 20, active: true, url: "https://x.com/daniel/status/1" },
    ],
  });
  assert.equal(await showWebPage(api, "https://x.com/daniel/status/1", { preferredTabId: 1 }), true);
  assert.deepEqual(calls.updatedTabs, [{ id: 1, props: { active: true } }]);
  assert.deepEqual(calls.focusedWindows, [{ id: 10, props: { focused: true } }]);
  assert.equal(calls.createdTabs.length, 0);

  // Without a preferred tab (e.g. from the Web app), an active matching tab wins over an inactive one.
  assert.equal(await showWebPage(api, "https://x.com/daniel/status/1#other"), true);
  assert.deepEqual(calls.updatedTabs.at(-1), { id: 2, props: { active: true } });
  assert.deepEqual(calls.focusedWindows.at(-1), { id: 20, props: { focused: true } });
});

test("without web-page host permission, askThread still brings back the tab the conversation came from", async () => {
  const href = "https://x.com/daniel/status/42";
  const { api, calls } = mockChrome({
    tabs: [
      { id: 5, windowId: 11, active: false }, // URL hidden without optional host permission.
      { id: 6, windowId: 11, active: true, url: "https://xmatrix.sh/app/s/channels/c" },
    ],
    session: {
      "askThread:5": { page: pageKey(href), spaceId: "s", channelId: "c" },
    },
  });
  assert.equal(await showWebPage(api, `${href}#fragment`), true);
  assert.deepEqual(calls.updatedTabs, [{ id: 5, props: { active: true } }]);
  assert.deepEqual(calls.focusedWindows, [{ id: 11, props: { focused: true } }]);
  assert.equal(calls.createdTabs.length, 0);
});

test("a remembered tab whose visible URL moved elsewhere is not hijacked, and a closed tab opens a new one", async () => {
  const href = "https://x.com/daniel/status/42";
  const moved = mockChrome({
    tabs: [{ id: 5, windowId: 11, active: false, url: "https://x.com/home" }],
    session: { "askThread:5": { page: pageKey(href), spaceId: "s", channelId: "c" } },
  });
  assert.equal(await findTabForPage(moved.api, href), null);
  assert.equal(await showWebPage(moved.api, href), true);
  assert.deepEqual(moved.calls.createdTabs, [{ url: href }]);
  assert.equal(moved.calls.updatedTabs.length, 0);

  // Non-web URLs are refused.
  assert.equal(await showWebPage(moved.api, "javascript:alert(1)"), false);
  assert.equal(moved.calls.createdTabs.length, 1);
});
