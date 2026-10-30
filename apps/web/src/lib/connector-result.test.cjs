const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const { splitConnectorResult } = require("./connector-result.ts");

const URL = "https://dash.cloudflare.com/62f1/workers/d1/databases/24bf";

test("a link after a fenced result comes off the closing fence", () => {
  const detail = "db: 1 row (195 rows read)\n```\nCOUNT(*)  MAX(created_at)\n5         2026-10-30\n```" + ` — ${URL}`;
  assert.deepEqual(splitConnectorResult(detail), {
    body: "db: 1 row (195 rows read)\n```\nCOUNT(*)  MAX(created_at)\n5         2026-10-30\n```",
    link: { href: URL, host: "dash.cloudflare.com" },
  });
});

test("a one-line result keeps its sentence and loses only the link", () => {
  assert.deepEqual(splitConnectorResult(`Rolled api back to abc — ${URL}`),
    { body: "Rolled api back to abc", link: { href: URL, host: "dash.cloudflare.com" } });
});

test("results without a trailing https link are left alone", () => {
  for (const detail of ["plain answer", "dash — http://example.com/x", "see https://example.com/x for more", "a — b"]) {
    assert.deepEqual(splitConnectorResult(detail), { body: detail });
  }
});
