const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const { installTypeScriptRequire } = require("../../components/dashboard/typescript-require.cjs");

installTypeScriptRequire();

const listeners = new Map();
const target = {
  addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
  removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== fn)),
};
function fire(type, event = {}) {
  for (const fn of listeners.get(type) ?? []) fn(event);
}
globalThis.window = { ...target, location: { origin: "https://xmatrix.test" } };
globalThis.document = { ...target, hidden: false };
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });

const sockets = [];
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  constructor(url, protocol) {
    this.url = url;
    this.protocol = protocol;
    this.readyState = FakeSocket.CONNECTING;
    this.handlers = new Map();
    this.closedWith = null;
    sockets.push(this);
  }
  addEventListener(type, fn) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]); }
  send() {}
  close(code) { this.closedWith = code; this.readyState = FakeSocket.CLOSED; }
  open() {
    this.readyState = FakeSocket.OPEN;
    for (const fn of this.handlers.get("open") ?? []) fn({});
  }
}
globalThis.WebSocket = FakeSocket;

const tickets = [];
globalThis.fetch = async (_url, init) => {
  tickets.push(init.headers.Authorization);
  return new Response(JSON.stringify({ protocol: "xmatrix-page-v2.1", socketPath: "/ws/page", canEdit: true }), { status: 200 });
};

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolve(request, parent, ...rest) {
  if (request.startsWith("@/")) return resolveFilename.call(this, path.join(__dirname, "../..", request.slice(2)), parent, ...rest);
  return resolveFilename.call(this, request, parent, ...rest);
};
const { PageLiveSession } = require("./page-client.ts");
Module._resolveFilename = resolveFilename;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a renewed token is used for the next ticket and keeps the document", async () => {
  tickets.length = 0;
  sockets.length = 0;
  const live = new PageLiveSession({ spaceId: "s", pageId: "p", token: "old", user: { name: "u", color: "#000" } });
  await settle();
  sockets[0].open();
  live.doc.getText("t").insert(0, "unsent edit");

  live.setToken("new");
  // Waking from sleep: hidden long enough that the OS dropped the socket.
  document.hidden = true;
  fire("visibilitychange");
  fire("pageshow", { persisted: true });
  document.hidden = false;
  fire("visibilitychange");
  await settle();

  assert.equal(sockets[0].closedWith, 4000, "the possibly dead socket is replaced");
  assert.equal(sockets.length, 2);
  assert.deepEqual(tickets, ["Bearer old", "Bearer new"]);
  assert.equal(live.doc.getText("t").toString(), "unsent edit");
  live.destroy();
});

test("an ordinary focus does not redial a working socket", async () => {
  sockets.length = 0;
  const live = new PageLiveSession({ spaceId: "s", pageId: "p", token: "t", user: { name: "u", color: "#000" } });
  await settle();
  sockets[0].open();
  fire("focus");
  await settle();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].closedWith, null);
  live.destroy();
});

test("a new page is only its document until the first write makes it, then goes on as the made page's session", async () => {
  sockets.length = 0;
  tickets.length = 0;
  const made = [];
  const notices = [];
  const live = new PageLiveSession({ spaceId: "s", pageId: null, token: "t", user: { name: "u", color: "#000" },
    make: async (document) => { made.push(document); return { pageId: "p-new", seeded: true }; } });
  live.on((notice) => notices.push(notice.type));
  await settle();
  assert.equal(sockets.length, 0, "nothing is asked of the Hub for a page nobody wrote on");
  assert.equal(live.underway, true);

  live.doc.getText("t").insert(0, "first words");
  live.doc.getText("t").insert(11, " and more");
  await settle();
  assert.equal(made.length, 1, "made once, from the document as it was first written");
  assert.ok(made[0] instanceof Uint8Array && made[0].length > 0);
  assert.equal(live.pageId, "p-new");
  assert.deepEqual(notices.filter((type) => type === "made"), ["made"]);
  await settle();
  assert.equal(sockets.length, 1, "the made page's session is joined with the same document");
  sockets[0].open();
  assert.equal(live.underway, false);
  assert.equal(live.doc.getText("t").toString(), "first words and more");
  live.destroy();
});

test("a new page whose making fails says so and is made on the next write; one not seeded is not joined", async () => {
  sockets.length = 0;
  let attempts = 0;
  const notices = [];
  const live = new PageLiveSession({ spaceId: "s", pageId: null, token: "t", user: { name: "u", color: "#000" },
    make: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return { pageId: "p-new", seeded: false };
    } });
  live.on((notice) => notices.push(notice.type === "error" ? notice.code : notice.type));
  live.doc.getText("t").insert(0, "a");
  await settle();
  assert.ok(notices.includes("page_create_failed"));
  assert.equal(live.pageId, null);
  live.doc.getText("t").insert(1, "b");
  await settle();
  assert.equal(attempts, 2);
  assert.equal(live.pageId, "p-new");
  await settle();
  assert.equal(sockets.length, 0, "a page made without this document opens afresh instead");
  live.destroy();
});
