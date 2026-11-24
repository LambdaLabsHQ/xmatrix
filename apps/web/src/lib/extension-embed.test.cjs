const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const { frameWindow } = require("./extension-embed-test-frame.cjs");

// The app packaged in the extension trades its session with the side panel
// page that frames it, over postMessage. These are the boundary's guarantees:
// the app is the panel's app only inside the allowed extension's own package,
// only that parent's messages are believed, and the session request is posted
// to that origin alone.
const EXTENSION = "chrome-extension://kaickfjmldmlelnfijaahialjpnebnak";

function load(t, ancestor) {
  const win = frameWindow(ancestor);
  globalThis.window = win;
  t.after(() => { delete globalThis.window; });
  return { win, embed: require("./extension-embed.ts") };
}

test("the app is the side panel's only inside the allowed extension's own package", (t) => {
  const { embed } = load(t, EXTENSION);
  assert.equal(embed.extensionEmbedParent(), EXTENSION);
  globalThis.window = frameWindow("chrome-extension://someoneelse");
  assert.equal(embed.extensionEmbedParent(), null);
  globalThis.window = frameWindow("https://evil.example");
  assert.equal(embed.extensionEmbedParent(), null);
  // The Web's own pages are never the panel's app, whoever frames them.
  globalThis.window = frameWindow(EXTENSION, "https://xmatrix.sh");
  assert.equal(embed.extensionEmbedParent(), null);
});

test("a session request goes to the extension only and believes only its answer", async (t) => {
  const { win, embed } = load(t, EXTENSION);
  const pending = embed.requestEmbedSession(EXTENSION, { timeoutMs: 1_000 });
  const [{ message, origin }] = win.parent.posted;
  assert.equal(origin, EXTENSION);
  assert.equal(message.type, "session-request");
  const answer = { protocol: "xmatrix-embed/1", type: "session", id: message.id };
  // A page in another frame, or another origin, cannot answer for the extension.
  win.dispatch({ source: {}, origin: EXTENSION, data: { ...answer, token: "forged-source" } });
  win.dispatch({ source: win.parent, origin: "https://evil.example", data: { ...answer, token: "forged-origin" } });
  win.dispatch({ source: win.parent, origin: EXTENSION, data: { ...answer, id: "other", token: "other-request" } });
  win.dispatch({ source: win.parent, origin: EXTENSION, data: { ...answer, token: "real" } });
  assert.deepEqual(await pending, { token: "real" });
});

test("a session answer's account is taken only when it is whole", async (t) => {
  const { win, embed } = load(t, EXTENSION);
  const ask = async (user, renew = false) => {
    const pending = embed.requestEmbedSession(EXTENSION, { timeoutMs: 1_000, renew });
    const { message } = win.parent.posted.at(-1);
    assert.equal(message.renew === true, renew);
    win.dispatch({ source: win.parent, origin: EXTENSION,
      data: { protocol: "xmatrix-embed/1", type: "session", id: message.id, token: "t", user } });
    return (await pending).user;
  };
  assert.deepEqual(await ask({ id: "u1", email: "a@example.com", name: "Ada", avatarUrl: "https://a.example/a.png", role: "admin" }),
    { id: "u1", email: "a@example.com", name: "Ada", avatarUrl: "https://a.example/a.png" });
  assert.deepEqual(await ask({ id: "u1", email: "a@example.com" }, true), { id: "u1", email: "a@example.com" });
  // Without an id or an email there is no account to open with: the app reads it from the Hub.
  assert.equal(await ask({ id: "u1", name: "Ada" }), undefined);
  assert.equal(await ask({ id: 7, email: "a@example.com" }), undefined);
  assert.equal(await ask("u1"), undefined);
});

test("a signed-out extension answers no token", async (t) => {
  const { win, embed } = load(t, EXTENSION);
  const pending = embed.requestEmbedSession(EXTENSION, { timeoutMs: 1_000 });
  const { id } = win.parent.posted[0].message;
  win.dispatch({ source: win.parent, origin: EXTENSION, data: { protocol: "xmatrix-embed/1", type: "signed-out", id } });
  assert.equal(await pending, null);
});

test("a passage must be bounded text from a web page with a known target", (t) => {
  const { embed } = load(t, EXTENSION);
  const passage = { text: "p99 rose to 9 s", label: "Incident 2481", href: "https://status.example.com/i/2481", target: "new" };
  assert.deepEqual(embed.parseEmbedPassage(passage), passage);
  assert.equal(embed.parseEmbedPassage({ ...passage, href: "javascript:alert(1)" }), null);
  assert.equal(embed.parseEmbedPassage({ ...passage, href: "chrome://settings" }), null);
  assert.equal(embed.parseEmbedPassage({ ...passage, target: "everyone" }), null);
  assert.equal(embed.parseEmbedPassage({ ...passage, text: "x".repeat(20_001) }), null);
  assert.equal(embed.parseEmbedPassage({ ...passage, text: " ", label: "" }), null);
});

test("passages from anyone but the framing extension are ignored", (t) => {
  const { win, embed } = load(t, EXTENSION);
  const seen = [];
  const stop = embed.subscribeEmbedPassages((passage) => seen.push(passage.text));
  assert.equal(win.parent.posted.at(-1).message.type, "ready");
  const data = { protocol: "xmatrix-embed/1", type: "passage", text: "hello", label: "T", href: "https://a.example/", target: "current" };
  win.dispatch({ source: {}, origin: EXTENSION, data });
  win.dispatch({ source: win.parent, origin: "https://a.example", data });
  win.dispatch({ source: win.parent, origin: EXTENSION, data });
  stop();
  win.dispatch({ source: win.parent, origin: EXTENSION, data });
  assert.deepEqual(seen, ["hello"]);
});

test("the extension may only open a conversation path of this app", (t) => {
  const { win, embed } = load(t, EXTENSION);
  const opened = [];
  const stop = embed.subscribeEmbedOpen((path) => opened.push(path) > 0);
  const send = (path, origin = EXTENSION) => win.dispatch({ source: win.parent, origin, data: { protocol: "xmatrix-embed/1", type: "open", path } });
  send("/app/space-1/channels/channel_2");
  send("https://evil.example/app/a/channels/b");
  send("/app/a/channels/b/../../login");
  send("//evil.example/app/a/channels/b");
  send("/app/a/settings/b");
  send("/app/a/channels/b", "https://evil.example");
  stop();
  assert.deepEqual(opened, ["/app/space-1/channels/channel_2"]);
});

test("an address the page is asked to navigate to goes to the open app, which says whether it shows it", (t) => {
  const { embed } = load(t, EXTENSION);
  assert.equal(embed.openEmbedAddress("/app/s/channels/c"), false);
  const stop = embed.subscribeEmbedOpen((path) => path.startsWith("/app/s/channels/"));
  assert.equal(embed.openEmbedAddress("/app/s/channels/c"), true);
  assert.equal(embed.openEmbedAddress("/app/s/settings"), false);
  stop();
  assert.equal(embed.openEmbedAddress("/app/s/channels/c"), false);
});

test("the page beside the panel is a web page, its content left to the Agent, and Recent holds only app conversations", (t) => {
  const { embed } = load(t, EXTENSION);
  const page = { title: "Incident 2481", href: "https://status.example.com/i/2481", path: "/app/s1/channels/c1" };
  assert.deepEqual(embed.parseEmbedPage(page), page);
  // A web page is not a file (Daniel 2026-11-24): its text is not handed over; an Agent reads it with `xmatrix browse`.
  assert.deepEqual(embed.parseEmbedPage({ ...page, text: "p99 rose" }), page);
  assert.equal(embed.parseEmbedPage({ ...page, href: "file:///etc/passwd" }), null);
  assert.deepEqual(embed.parseEmbedPage({ ...page, path: "/app/s1/settings" }), { title: page.title, href: page.href });
  assert.deepEqual(embed.parseEmbedRecent([
    { path: "/app/s1/channels/c1", title: "One", href: "https://a.example/" },
    { path: "https://evil.example/", title: "Two", href: "https://a.example/" },
    { path: "/app/s1/channels/c3", title: "Three", href: "javascript:alert(1)" },
  ]), [{ path: "/app/s1/channels/c1", title: "One", href: "https://a.example/" }]);
});

// `xmatrix browse`: the Hub's request goes to the panel only, and the panel's approval prompts are checked.
test("an Agent's page read goes to the side panel, and its approval prompt must name a web page", (t) => {
  const { win, embed } = load(t, EXTENSION);
  embed.forwardEmbedBrowserRead({ requestId: "req-12345678", channelId: "c1", target: "conversation", agentName: "claude" });
  assert.deepEqual(win.parent.posted.at(-1), { origin: EXTENSION, message: { protocol: "xmatrix-embed/1", type: "browser-read",
    requestId: "req-12345678", channelId: "c1", target: "conversation", agentName: "claude" } });
  const seen = [];
  const stop = embed.subscribeEmbedBrowserReadApprovals((approval) => seen.push(approval));
  const prompt = { protocol: "xmatrix-embed/1", type: "browser-read-approve", requestId: "req-1", agentName: "claude",
    title: "Inbox", href: "https://mail.example/inbox" };
  win.dispatch({ source: win.parent, origin: EXTENSION, data: prompt });
  win.dispatch({ source: win.parent, origin: EXTENSION, data: { ...prompt, requestId: "req-2", href: "chrome://settings" } });
  win.dispatch({ source: win.parent, origin: "https://evil.example", data: { ...prompt, requestId: "req-3" } });
  stop();
  assert.deepEqual(seen, [{ requestId: "req-1", agentName: "claude", title: "Inbox", href: "https://mail.example/inbox" }]);
  embed.answerEmbedBrowserReadApproval("req-1", true);
  assert.deepEqual(win.parent.posted.at(-1).message, { protocol: "xmatrix-embed/1", type: "browser-read-approval", requestId: "req-1", allow: true });
});

test("outside the side panel an Agent's page read goes nowhere", (t) => {
  const { win, embed } = load(t, "https://evil.example");
  embed.forwardEmbedBrowserRead({ requestId: "req-12345678", channelId: "c1", target: "conversation", agentName: "claude" });
  assert.equal(win.parent.posted.length, 0);
});

test("a web page the person wrote from is brought back in its own tab, and only a web page", (t) => {
  const { win, embed } = load(t, EXTENSION);
  assert.equal(embed.showEmbedWebPage("https://x.com/daniel/status/1"), true);
  assert.deepEqual(win.parent.posted.at(-1), { origin: EXTENSION,
    message: { protocol: "xmatrix-embed/1", type: "show-page", href: "https://x.com/daniel/status/1" } });
  assert.equal(embed.showEmbedWebPage("javascript:alert(1)"), false);
  assert.equal(win.parent.posted.length, 1);
  // Outside the side panel the card stays a plain link.
  globalThis.window = frameWindow("https://evil.example");
  assert.equal(embed.showEmbedWebPage("https://x.com/daniel/status/1"), false);
});

// Each message written in the side panel carries the page beside it (browser-page.ts).
test("the side panel knows the page beside it, and messages carry only a web page", (t) => {
  const { win, embed } = load(t, EXTENSION);
  const stop = embed.subscribeEmbedPage(() => undefined);
  win.dispatch({ source: win.parent, origin: EXTENSION, data: { protocol: "xmatrix-embed/1", type: "page",
    title: "Incident 2481", href: "https://status.example.com/i/2481", text: "p99 rose" } });
  stop();
  assert.deepEqual(embed.embedBrowserPage(), { title: "Incident 2481", href: "https://status.example.com/i/2481" });
  const { browserPageMetadata, browserPageOf } = require("@xmatrix/protocol");
  const metadata = browserPageMetadata(embed.embedBrowserPage());
  assert.deepEqual(browserPageOf(metadata), { title: "Incident 2481", href: "https://status.example.com/i/2481" });
  assert.equal(browserPageOf({ browserPage: { title: "x", href: "javascript:alert(1)" } }), null);
  assert.equal(browserPageOf({ other: true }), null);
  globalThis.window = require("./extension-embed-test-frame.cjs").frameWindow("https://evil.example");
  assert.equal(embed.embedBrowserPage(), null);
});

// The composer's page chip: × takes this page off what is written, until the panel is beside another page.
test("the person can leave the page beside the panel off, until they move to another", (t) => {
  const { win, embed } = load(t, EXTENSION);
  const stop = embed.subscribeEmbedPage(() => undefined);
  let changes = 0;
  const unsubscribe = embed.subscribeEmbedBrowserPage(() => { changes += 1; });
  const show = (href, title) => win.dispatch({ source: win.parent, origin: EXTENSION,
    data: { protocol: "xmatrix-embed/1", type: "page", title, href } });
  show("https://a.example/one", "One");
  assert.deepEqual(embed.embedBrowserPage(), { title: "One", href: "https://a.example/one" });
  embed.leaveOutEmbedBrowserPage();
  assert.equal(embed.embedBrowserPage(), null);
  show("https://a.example/two", "Two");
  assert.deepEqual(embed.embedBrowserPage(), { title: "Two", href: "https://a.example/two" });
  show("https://a.example/one", "One");
  assert.equal(embed.embedBrowserPage(), null);
  assert.ok(changes >= 3);
  unsubscribe();
  stop();
});

// A question asked in the box on a page is shown in the panel as sending at once (Daniel 2026-11-24: too slow).
test("the question on its way is a bounded message with its own id and the page it was asked on", (t) => {
  const { embed } = load(t, EXTENSION);
  const pending = { clientMessageId: "0b6c6a3e-6f1b-4a5c-9f1e-2a9d8c7b6a51", body: "> quote\n\nis this right?",
    metadata: { browserPage: { title: "Home / X", href: "https://x.com/home" } } };
  assert.deepEqual(embed.parseEmbedPendingMessage(pending), pending);
  assert.equal(embed.parseEmbedPendingMessage({ ...pending, clientMessageId: "x" }), undefined);
  assert.equal(embed.parseEmbedPendingMessage({ ...pending, body: "   " }), undefined);
  assert.equal(embed.parseEmbedPendingMessage({ ...pending, body: "x".repeat(64 * 1024 + 1) }), undefined);
  // Only a web page goes with it; anything else the metadata holds is dropped.
  assert.deepEqual(embed.parseEmbedPendingMessage({ ...pending, metadata: { browserPage: { href: "javascript:1" }, xmatrixSystemNotice: true } }),
    { clientMessageId: pending.clientMessageId, body: pending.body });
});
