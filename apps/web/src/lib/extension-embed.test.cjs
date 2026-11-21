const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

// The side panel's frame trades an access token with its parent over
// postMessage. These are the boundary's guarantees: only the allowed extension
// is recognised, only its own messages are believed, and the token request is
// posted to that origin alone.
const EXTENSION = "chrome-extension://kaickfjmldmlelnfijaahialjpnebnak";

function frameWindow(ancestor) {
  const listeners = new Set();
  const parent = { posted: [], postMessage(message, origin) { this.posted.push({ message, origin }); } };
  const win = {
    parent,
    location: { ancestorOrigins: [ancestor], href: "https://xmatrix.sh/app", origin: "https://xmatrix.sh" },
    addEventListener: (type, listener) => type === "message" && listeners.add(listener),
    removeEventListener: (type, listener) => listeners.delete(listener),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    dispatch: (event) => { for (const listener of Array.from(listeners)) listener(event); },
  };
  return win;
}

function load(t, ancestor) {
  const win = frameWindow(ancestor);
  globalThis.window = win;
  t.after(() => { delete globalThis.window; });
  return { win, embed: require("./extension-embed.ts") };
}

test("only the allowed extension is a side-panel parent", (t) => {
  const { embed } = load(t, EXTENSION);
  assert.equal(embed.extensionEmbedParent(), EXTENSION);
  globalThis.window = frameWindow("chrome-extension://someoneelse");
  assert.equal(embed.extensionEmbedParent(), null);
  globalThis.window = frameWindow("https://evil.example");
  assert.equal(embed.extensionEmbedParent(), null);
});

test("a token request goes to the extension only and believes only its answer", async (t) => {
  const { win, embed } = load(t, EXTENSION);
  const pending = embed.requestEmbedToken(EXTENSION, 1_000);
  const [{ message, origin }] = win.parent.posted;
  assert.equal(origin, EXTENSION);
  assert.equal(message.type, "session-request");
  const answer = { protocol: "xmatrix-embed/1", type: "session", id: message.id };
  // A page in another frame, or another origin, cannot answer for the extension.
  win.dispatch({ source: {}, origin: EXTENSION, data: { ...answer, token: "forged-source" } });
  win.dispatch({ source: win.parent, origin: "https://evil.example", data: { ...answer, token: "forged-origin" } });
  win.dispatch({ source: win.parent, origin: EXTENSION, data: { ...answer, id: "other", token: "other-request" } });
  win.dispatch({ source: win.parent, origin: EXTENSION, data: { ...answer, token: "real" } });
  assert.equal(await pending, "real");
});

test("a signed-out extension answers no token", async (t) => {
  const { win, embed } = load(t, EXTENSION);
  const pending = embed.requestEmbedToken(EXTENSION, 1_000);
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

test("the proxy takes a request's own client identity only from a compatible app", () => {
  const { parseAppCompatibilityHeaders } = require("./client-compatibility-server.ts");
  const { CLIENT_COMPATIBILITY_POLICY } = require("@xmatrix/protocol");
  const headers = (values) => new Headers(Object.entries(values).map(([key, value]) => [`x-xmatrix-client-${key}`, value]));
  const app = { component: "app", version: "99.0.0", protocol: String(CLIENT_COMPATIBILITY_POLICY.protocolVersion), platform: "chrome-extension" };
  assert.equal(parseAppCompatibilityHeaders(headers(app))?.platform, "chrome-extension");
  assert.equal(parseAppCompatibilityHeaders(headers({ ...app, component: "cli" })), undefined);
  assert.equal(parseAppCompatibilityHeaders(headers({ ...app, version: "0.0.1" })), undefined);
  assert.equal(parseAppCompatibilityHeaders(headers({ ...app, protocol: "1" })), undefined);
  assert.equal(parseAppCompatibilityHeaders(new Headers()), undefined);
});

test("the extension may only open a conversation path of this app", (t) => {
  const { win, embed } = load(t, EXTENSION);
  const opened = [];
  const stop = embed.subscribeEmbedOpen((path) => opened.push(path));
  const send = (path, origin = EXTENSION) => win.dispatch({ source: win.parent, origin, data: { protocol: "xmatrix-embed/1", type: "open", path } });
  send("/app/space-1/channel_2");
  send("https://evil.example/app/a/b");
  send("/app/a/b/../../login");
  send("//evil.example/app/a/b");
  send("/app/a/b", "https://evil.example");
  stop();
  assert.deepEqual(opened, ["/app/space-1/channel_2"]);
});
