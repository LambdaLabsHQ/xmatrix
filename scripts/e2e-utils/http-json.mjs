import assert from "node:assert/strict";

export async function expectJson(response) {
  const text = await response.text();
  const payload = text.trim() ? JSON.parse(text) : {};
  assert.equal(response.ok, true, text);
  return payload;
}

export function fetchJson(hubUrl, token, path, init = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    ...init.headers,
  };
  if (init.body && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  return fetch(`${hubUrl}${path}`, { ...init, headers });
}


export async function ensureHubTarget(args, startLocalWorker) {
  if (args.hubUrl) {
    if (!args.token) throw new Error("A token is required in --hub-url mode");
    return null;
  }
  if (args.skipLocalWorker) {
    throw new Error("--hub-url is required with --skip-local-worker");
  }

  const local = await startLocalWorker();
  args.hubUrl = local.hubUrl;
  args.token = local.token;
  return local;
}
