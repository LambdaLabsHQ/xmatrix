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

/** Run an operation against queued provider replies (`body`, `status`, `raw` text or a thrown `error`). */
export async function withProviderResponses(responses, operation) {
  const fetch = stubFetchResponses(responses, {
    decodeBody: body => body instanceof URLSearchParams ? Object.fromEntries(body) : body ? JSON.parse(body) : undefined,
    reply: response => {
      if (response.error) throw response.error;
      return new Response("raw" in response ? response.raw : JSON.stringify(response.body ?? {}), { status: response.status ?? 200 });
    },
  });
  try { return { result: await operation(fetch.calls), calls: fetch.calls }; }
  finally { fetch.restore(); }
}
