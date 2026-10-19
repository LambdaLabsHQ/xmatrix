const assert = require("node:assert/strict");
const test = require("node:test");
const { installTypeScriptRequire } = require("../../components/dashboard/typescript-require.cjs");

installTypeScriptRequire();

const { evaluateClientCompatibility } = require("@xmatrix/protocol");
const { admitAppCompatibility } = require("../app-client-compatibility.ts");
const { xmatrixHubRead } = require("./hub-read.ts");

const HUB = "https://xmatrix-hub.xmatrix.sh";
const read = (signal) => xmatrixHubRead({ hubPath: "/api/spaces/s1/pages", webUrl: "/api/xmatrix/spaces/s1/pages",
  token: "token-1", signal });

/** Answers each request with what `answer` gives for its URL, recording every request. */
function serve(t, answer) {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), headers: new Headers(init.headers), cache: init.cache });
    return answer(String(url), init);
  };
  return requests;
}

test.before(() => {
  globalThis.window = { location: { origin: "https://xmatrix.sh" }, dispatchEvent: () => true };
});

test("before the app is admitted, a read goes through the Web", async (t) => {
  const requests = serve(t, () => Response.json({ pages: [] }));
  assert.deepEqual(await read(), { pages: [] });
  assert.deepEqual(requests.map((request) => request.url), ["/api/xmatrix/spaces/s1/pages"]);
});

test("the admitted app reads from the Hub straight, with its bearer and identity, and from the Web when the Hub will not answer", async (t) => {
  const identity = { component: "app", version: "1.1.1", protocolVersion: 2, platform: "web" };
  serve(t, () => Response.json(evaluateClientCompatibility(identity)));
  await admitAppCompatibility(identity);

  let hub = () => Response.json({ pages: ["from the Hub"] });
  const toHub = (url) => new URL(url, "https://xmatrix.sh").origin === HUB;
  const requests = serve(t, (url, init) => toHub(url) ? hub(url, init) : Response.json({ pages: ["from the Web"] }));
  assert.deepEqual(await read(), { pages: ["from the Hub"] });
  assert.equal(requests[0].url, `${HUB}/api/spaces/s1/pages`);
  assert.equal(requests[0].headers.get("authorization"), "Bearer token-1");
  assert.equal(requests[0].headers.get("x-xmatrix-client-version"), "1.1.1");
  // A cache mode that skips the cache would make Chrome ask the preflight again before every read.
  assert.equal(requests[0].cache, "default");

  // A token the Hub no longer takes, a refused identity, or no answer across origins: the Web answers.
  for (const refuse of [() => new Response("{}", { status: 401 }), () => new Response("{}", { status: 426 }),
    () => { throw new TypeError("Failed to fetch"); }]) {
    hub = refuse;
    requests.length = 0;
    assert.deepEqual(await read(), { pages: ["from the Web"] });
    assert.deepEqual(requests.map((request) => request.url), [`${HUB}/api/spaces/s1/pages`, "/api/xmatrix/spaces/s1/pages"]);
  }

  // The Hub's own refusal is the answer: the Web would forward the same.
  hub = () => Response.json({ error: "Page not found", code: "page_not_found" }, { status: 404 });
  requests.length = 0;
  await assert.rejects(read(), (error) => error.status === 404 && error.code === "page_not_found");
  assert.equal(requests.length, 1);

  // A read its caller ended is not asked again of the Web.
  const controller = new AbortController();
  hub = () => { controller.abort(); throw new DOMException("aborted", "AbortError"); };
  requests.length = 0;
  await assert.rejects(read(controller.signal), (error) => error.name === "AbortError");
  assert.equal(requests.length, 1);

  // An app shell at another origin reads through the Web.
  globalThis.window.location.origin = "https://appassets.example";
  t.after(() => { globalThis.window.location.origin = "https://xmatrix.sh"; });
  hub = () => Response.json({ pages: ["from the Hub"] });
  requests.length = 0;
  assert.deepEqual(await read(), { pages: ["from the Web"] });
  assert.deepEqual(requests.map((request) => request.url), ["/api/xmatrix/spaces/s1/pages"]);

  // The ticket a live session opens with is asked for the same way, its body as JSON.
  globalThis.window.location.origin = "https://xmatrix.sh";
  hub = () => Response.json({ protocol: "ticket" });
  const posted = [];
  serve(t, async (url, init) => {
    posted.push({ url, method: init.method, body: init.body, type: new Headers(init.headers).get("content-type") });
    return toHub(url) ? hub(url, init) : Response.json({ protocol: "web" });
  });
  assert.deepEqual(await xmatrixHubRead({ hubPath: "/api/spaces/s1/pages/p1/live", webUrl: "/api/xmatrix/spaces/s1/pages/p1/live",
    token: "token-1", method: "POST", body: { document: "prosemirror" } }), { protocol: "ticket" });
  assert.deepEqual(posted, [{ url: `${HUB}/api/spaces/s1/pages/p1/live`, method: "POST",
    body: JSON.stringify({ document: "prosemirror" }), type: "application/json" }]);
  hub = () => new Response("{}", { status: 401 });
  posted.length = 0;
  assert.deepEqual(await xmatrixHubRead({ hubPath: "/api/spaces/s1/pages/p1/live", webUrl: "/api/xmatrix/spaces/s1/pages/p1/live",
    token: "token-1", method: "POST", body: { document: "prosemirror" } }), { protocol: "web" });
  assert.deepEqual(posted.map((request) => [request.url, request.method, request.type]), [
    [`${HUB}/api/spaces/s1/pages/p1/live`, "POST", "application/json"],
    ["/api/xmatrix/spaces/s1/pages/p1/live", "POST", "application/json"]]);
});
