import assert from "node:assert/strict";

/** Record each provider call and consume its queued JSON response in order. */
export function stubFetchResponses(responses, { decodeBody = value => value, allowUnexpected = false, reply = response => new Response(JSON.stringify(response.body), { status: response.status ?? 200 }) } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: new Headers(init.headers), body: decodeBody(init.body) });
    const next = responses.shift() ?? (allowUnexpected ? { body: {} } : undefined);
    assert.ok(next, "unexpected provider request");
    return reply(next);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
