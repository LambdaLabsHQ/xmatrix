const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");
require("../../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

// The Hub is stood in for: each read is recorded and answered from `faces`.
const reads = [];
let faces = {};
let failing = false;
const hubRead = path.join(__dirname, "../query/hub-read.ts");
const stub = new Module(hubRead);
stub.filename = hubRead;
stub.loaded = true;
stub.exports = {
  xmatrixHubRead: async ({ hubPath, token }) => {
    const url = new URL(hubPath, "https://hub.example");
    reads.push({ path: url.pathname, users: url.searchParams.getAll("user"), agents: url.searchParams.getAll("agent"), token });
    if (failing) throw new Error("offline");
    return {
      users: url.searchParams.getAll("user").map((id) => ({ id, imageUrl: faces[`user:${id}`] ?? null })),
      agents: url.searchParams.getAll("agent").map((id) => ({ id, imageUrl: faces[`agent:${id}`] ?? null })),
    };
  },
};
require.cache[hubRead] = stub;
const stored = new Map();
global.window = { localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) } };

const { FaceDirectory } = require("./face-directory.ts");
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test.beforeEach(() => {
  reads.length = 0;
  faces = { "user:ada": "https://hub.example/api/avatars/ada/1.png", "agent:chan:1": "/agent-vendors/claude.svg" };
  failing = false;
  stored.clear();
});

test("the faces one render asks for are read together, once, in the reader's Space", async () => {
  const directory = new FaceDirectory();
  let changes = 0;
  directory.subscribe(() => changes++);
  directory.want("user:ada", "space-1", "token");
  directory.want("agent:chan:1", "space-1", "token");
  directory.want("user:ada", "space-1", "token");
  await settle();
  assert.deepEqual(reads, [{ path: "/api/spaces/space-1/faces", users: ["ada"], agents: ["chan:1"], token: "token" }]);
  assert.equal(directory.get("user:ada").imageUrl, faces["user:ada"]);
  assert.equal(directory.get("agent:chan:1").imageUrl, "/agent-vendors/claude.svg");
  assert.ok(changes >= 1);
  directory.want("user:ada", "space-1", "token");
  await settle();
  assert.equal(reads.length, 1, "a face read a moment ago is not read again");
});

test("a person without a picture is known to have none; a failed read keeps what was known and is tried again", async () => {
  const directory = new FaceDirectory();
  directory.want("user:bob", "space-1", "token");
  await settle();
  assert.deepEqual(directory.get("user:bob"), { imageUrl: null, at: directory.get("user:bob").at });
  failing = true;
  directory.set("user:ada", faces["user:ada"]);
  directory.get("user:ada").at = 0;
  directory.want("user:ada", "space-1", "token");
  await settle();
  assert.equal(directory.get("user:ada").imageUrl, faces["user:ada"], "a stale face is drawn as kept while it is read again");
  const retryIn = directory.get("user:ada").at + 10 * 60_000 - Date.now();
  assert.ok(retryIn > 0 && retryIn <= 30_000, "and tried again within half a minute");
});

test("what was read survives a reload, and the reader's own new picture shows at once", async () => {
  const first = new FaceDirectory();
  first.want("user:ada", "space-1", "token");
  await settle();
  first.set("user:me", "https://hub.example/api/avatars/me/2.png");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const reloaded = new FaceDirectory();
  assert.equal(reloaded.get("user:ada").imageUrl, faces["user:ada"]);
  assert.equal(reloaded.get("user:me").imageUrl, "https://hub.example/api/avatars/me/2.png");
  reloaded.want("user:ada", "space-1", "token");
  await settle();
  assert.equal(reads.length, 1, "kept faces are drawn on reload without a read");
});

test("more faces than one read carries are read in several", async () => {
  const directory = new FaceDirectory();
  for (let index = 0; index < 120; index++) directory.want(`user:u${index}`, "space-1", "token");
  await settle();
  assert.deepEqual(reads.map((read) => read.users.length), [50, 50, 20]);
});
