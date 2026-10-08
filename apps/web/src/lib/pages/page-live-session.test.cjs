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

  assert.equal(sockets[0].closedWith, 1000, "the possibly dead socket is replaced");
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
