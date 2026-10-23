const assert = require("node:assert/strict");
const test = require("node:test");

let authorizeInBrowser;
let hubSignInStartUrl;

test.before(async () => {
  ({ authorizeInBrowser, hubSignInStartUrl } = await import("./browser-authorization.ts"));
});

test("only the Hub's sign-in start page may be opened, and local hosts only in a development build", () => {
  const start = "https://xmatrix-hub.xmatrix.sh/api/auth/app/start?provider=google";
  assert.equal(hubSignInStartUrl(start, { allowLocal: false })?.toString(), start);
  for (const refused of ["https://evil.example/api/auth/app/start", "http://xmatrix-hub.xmatrix.sh/api/auth/app/start",
    "https://xmatrix-hub.xmatrix.sh/other", "https://user@xmatrix-hub.xmatrix.sh/api/auth/app/start",
    // The Hub itself only: neither Web, no other host under xmatrix.sh, no other port.
    "https://xmatrix.sh/api/auth/app/start", "https://beta.xmatrix.sh/api/auth/app/start",
    "https://other.xmatrix.sh/api/auth/app/start", "https://xmatrix-hub.xmatrix.sh:8443/api/auth/app/start",
    "https://xmatrix-hub.xmatrix.sh.evil.example/api/auth/app/start",
    "http://localhost:8787/api/auth/app/start", "not a url", 42]) {
    assert.equal(hubSignInStartUrl(refused, { allowLocal: false }), null, String(refused));
  }
  assert.ok(hubSignInStartUrl("http://localhost:8787/api/auth/app/start", { allowLocal: true }));
});

test("the browser's return to the loopback page is the answer, once; the app is brought back", async () => {
  let opened;
  let answered = 0;
  const pending = authorizeInBrowser(new URL("https://xmatrix-hub.xmatrix.sh/api/auth/app/start?state=s"), "redirect_uri",
    async (page) => { opened = new URL(page); }, () => { answered += 1; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const returnTo = new URL(opened.searchParams.get("redirect_uri"));
  assert.equal(returnTo.hostname, "127.0.0.1");
  assert.equal(returnTo.pathname, "/callback");

  assert.equal((await fetch(new URL("/elsewhere", returnTo))).status, 404);
  const landed = await fetch(`${returnTo}?code=abc&state=s`);
  assert.equal(landed.status, 200);
  assert.match(await landed.text(), /You're signed in/u);
  assert.equal(await pending, `${returnTo}?code=abc&state=s`);
  assert.equal(answered, 1);
  // The port closes with the answer: nothing more is listened for.
  await assert.rejects(fetch(`${returnTo}?code=other&state=s`));
});

test("a newer sign-in replaces one still waiting, which reads as cancelled", async () => {
  const start = new URL("https://xmatrix-hub.xmatrix.sh/api/auth/app/start");
  const cancelled = (error) => error.name === "AbortError";
  const first = authorizeInBrowser(start, "redirect_uri", async () => {}, () => {});
  const second = authorizeInBrowser(start, "redirect_uri", async () => {}, () => {});
  await assert.rejects(first, cancelled);
  // A browser that cannot open ends its own sign-in, after replacing the one before it.
  const unopened = authorizeInBrowser(start, "redirect_uri", async () => { throw new Error("no browser"); }, () => {});
  await assert.rejects(second, cancelled);
  await assert.rejects(unopened, /no browser/u);
});
