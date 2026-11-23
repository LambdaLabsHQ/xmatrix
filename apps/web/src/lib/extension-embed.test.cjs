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

test("the page beside the panel is a web page with bounded text, and Recent holds only app conversations", (t) => {
  const { embed } = load(t, EXTENSION);
  const page = { title: "Incident 2481", href: "https://status.example.com/i/2481", text: "p99 rose", path: "/app/s1/channels/c1" };
  assert.deepEqual(embed.parseEmbedPage(page), page);
  assert.equal(embed.parseEmbedPage({ ...page, href: "file:///etc/passwd" }), null);
  assert.deepEqual(embed.parseEmbedPage({ ...page, text: "x".repeat(200_001) }), { title: page.title, href: page.href, path: page.path });
  assert.deepEqual(embed.parseEmbedPage({ ...page, path: "/app/s1/settings" }), { title: page.title, href: page.href, text: page.text });
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
