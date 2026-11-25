import assert from "node:assert/strict";
import test from "node:test";

import { clearAllTabThreads, clearTabThread, findConversationTab, findTabForPage, isTrustedWebAppOrigin, migrateTabThread, pageKey, pruneClosedTabThreads, selectBrowserReadTab, setTabThread, showWebPage, tabPageThread } from "../src/page-tab.js";

function mockChrome({ tabs = [], session = {}, local = {} } = {}) {
  const calls = { updatedTabs: [], focusedWindows: [], createdTabs: [] };
  const pick = (store, key) => {
    if (key === null || key === undefined) return { ...store };
    if (typeof key === "string") return key in store ? { [key]: store[key] } : {};
    return Object.fromEntries(key.filter((k) => k in store).map((k) => [k, store[k]]));
  };
  const remove = (store, keys) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
  };
  const api = {
    tabs: {
      async get(id) {
        const found = tabs.find((tab) => tab.id === id);
        if (!found) throw new Error("No tab with id");
        return found;
      },
      async query(filter = {}) {
        return tabs.filter((tab) => (filter.active === undefined || tab.active === filter.active));
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
      local: {
        async get(key) { return pick(local, key); },
        async set(values) { Object.assign(local, values); },
        async remove(keys) { remove(local, keys); },
      },
      session: {
        async get(key) { return pick(session, key); },
        async set(values) { Object.assign(session, values); },
        async remove(keys) { remove(session, keys); },
      },
    },
  };
  return { api, calls, local, session };
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

test("tabPageThread binds one thread per tab in storage.local across URL navigation and prunes closed tabs on startup", async () => {
  const { api, local } = mockChrome({
    tabs: [
      { id: 7, windowId: 1, active: true, url: "https://x.com/other/status/999" },
    ],
  });
  await setTabThread(api, 7, { page: "https://x.com/fly3nn/status/1", spaceId: "s1", channelId: "c1", title: "Thread 1" });
  await setTabThread(api, 99, { page: "https://x.com/closed/status/2", spaceId: "s1", channelId: "c2", title: "Closed Tab" });

  // Navigating to a different tweet URL in the same tab keeps the tab's thread.
  const kept = await tabPageThread(api, 7);
  assert.equal(kept?.channelId, "c1");
  assert.equal(kept?.spaceId, "s1");

  // Startup pruning removes closed tab 99 while preserving live tab 7.
  const pruned = await pruneClosedTabThreads(api);
  assert.deepEqual(pruned, ["askThread:99"]);
  assert.equal((await tabPageThread(api, 7))?.channelId, "c1");
  assert.equal(await tabPageThread(api, 99), null);
  assert.equal("askThread:99" in local, false);

  // Clicking "+" clears the tab's bound thread cleanly.
  await clearTabThread(api, 7);
  assert.equal(await tabPageThread(api, 7), null);
});

test("migrateTabThread preserves binding across tab ID replacement and clearAllTabThreads wipes all bindings on startup", async () => {
  const { api, local } = mockChrome({ tabs: [{ id: 10, windowId: 1, active: true }] });
  await setTabThread(api, 10, { page: "https://x.com/a", spaceId: "s1", channelId: "c1", title: "T1" });
  await setTabThread(api, 11, { page: "https://x.com/b", spaceId: "s1", channelId: "c2", title: "T2" });

  assert.equal(await migrateTabThread(api, 10, 42), true);
  assert.equal(await tabPageThread(api, 10), null);
  assert.equal((await tabPageThread(api, 42))?.channelId, "c1");
  assert.equal(await migrateTabThread(api, 999, 43), false);

  const cleared = await clearAllTabThreads(api);
  assert.deepEqual(cleared.sort(), ["askThread:11", "askThread:42"]);
  assert.equal(await tabPageThread(api, 42), null);
  assert.equal(await tabPageThread(api, 11), null);
  assert.equal(Object.keys(local).some((key) => key.startsWith("askThread:")), false);
});

test("findConversationTab locates the tab bound to a channelId and distinguishes closed vs unbound", async () => {
  const { api } = mockChrome({
    tabs: [
      { id: 10, windowId: 1, active: false, url: "https://x.com/daniel/status/1" },
      { id: 20, windowId: 1, active: true, url: "https://example.test/other" },
    ],
    local: {
      "askThread:10": { page: "https://x.com/daniel/status/1", spaceId: "s1", channelId: "chan-a", title: "A" },
      "askThread:99": { page: "https://x.com/closed/status/2", spaceId: "s1", channelId: "chan-closed", title: "Closed" },
    },
  });
  const live = await findConversationTab(api, "chan-a");
  assert.equal(live.hasBinding, true);
  assert.equal(live.tab?.id, 10);

  const closed = await findConversationTab(api, "chan-closed");
  assert.equal(closed.hasBinding, true);
  assert.equal(closed.tab, null);

  const missing = await findConversationTab(api, "chan-unknown");
  assert.equal(missing.hasBinding, false);
  assert.equal(missing.tab, null);
});

test("selectBrowserReadTab refuses unrelated foreground tabs with no xMatrix UI or binding", async () => {
  // Tab A has a bound thread, Tab B (bank/email) has NO xMatrix side panel or binding and is in front.
  const { api } = mockChrome({
    tabs: [
      { id: 10, windowId: 1, active: false, url: "https://x.com/daniel/status/1" },
      { id: 20, windowId: 1, active: true, url: "https://bank.example/accounts" },
    ],
    local: {
      "askThread:10": { page: "https://x.com/daniel/status/1", spaceId: "s1", channelId: "chan-a", title: "A" },
    },
  });

  // Unbound channel asking for `current` MUST NOT read foreground Tab B!
  const unrelated = await selectBrowserReadTab(api, { channelId: "chan-other", openPanelTabIds: new Set() });
  assert.equal(unrelated.tab, null);
  assert.equal(unrelated.refusal, "no-page");

  // Also refused when channelId is omitted and foreground Tab B has no xMatrix UI.
  const omitted = await selectBrowserReadTab(api, { channelId: "", openPanelTabIds: new Set() });
  assert.equal(omitted.tab, null);
  assert.equal(omitted.refusal, "no-page");

  // Bound channel `chan-a` reads its own bound Tab A — never foreground Tab B.
  const bound = await selectBrowserReadTab(api, { channelId: "chan-a", openPanelTabIds: new Set() });
  assert.equal(bound.refusal, null);
  assert.equal(bound.tab?.id, 10);

  // Foreground tab IS allowed when its own side panel is open.
  const withPanel = await selectBrowserReadTab(api, { channelId: "chan-other", openPanelTabIds: new Set([20]) });
  assert.equal(withPanel.refusal, null);
  assert.equal(withPanel.tab?.id, 20);

  // R5 #1: Unbound channel X MUST NOT read foreground tab T that is only bound to a DIFFERENT channel Y (and has no open side panel).
  const crossChannel = mockChrome({
    tabs: [{ id: 30, windowId: 1, active: true, url: "https://x.com/private-chat-y" }],
    local: {
      "askThread:30": { page: "https://x.com/private-chat-y", spaceId: "s1", channelId: "chan-y", title: "Y" },
    },
  });
  const refusedCross = await selectBrowserReadTab(crossChannel.api, { channelId: "chan-x", openPanelTabIds: new Set() });
  assert.equal(refusedCross.tab, null);
  assert.equal(refusedCross.refusal, "no-page");
});

test("selectBrowserReadTab prefers the active tab when multiple tabs are bound to the same conversation", async () => {
  const { api } = mockChrome({
    tabs: [
      { id: 10, windowId: 1, active: false, url: "https://x.com/a" },
      { id: 11, windowId: 1, active: true, url: "https://x.com/b" },
    ],
    local: {
      "askThread:10": { page: "https://x.com/a", spaceId: "s1", channelId: "chan-shared", title: "Shared" },
      "askThread:11": { page: "https://x.com/b", spaceId: "s1", channelId: "chan-shared", title: "Shared" },
    },
  });
  const chosen = await selectBrowserReadTab(api, { channelId: "chan-shared", openPanelTabIds: new Set() });
  assert.equal(chosen.refusal, null);
  assert.equal(chosen.tab?.id, 11);
});
