import { webcrypto } from "node:crypto";

import { parseActionCommand } from "../../src/connectors/action-parse.ts";
import { connectorProvider } from "../../src/connectors/registry.ts";

/* A generated App Store Connect API key and a double of Apple's API for the connector's tests. */

export const ACTIONS = connectorProvider("appstoreconnect").actions;
export const BUNDLE = "com.example.app";
export const APP = { type: "apps", id: "6760000001", attributes: { bundleId: BUNDLE, name: "Example" } };

export const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
export const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/gu).join("\n")}\n-----END PRIVATE KEY-----\n`;
export const credentials = { issuerId: "57246542-96fe-1a63-e053-0824d011072a", keyId: "2X9R4HXF34", privateKey: pem,
  webhookSecret: "hook-secret", ingressKey: "ingress-key" };

/* Keyed by "METHOD /v1/path"; every call is recorded with its `data` as `body` and inline creates as `included`.
   A route answers a JSON:API document, `{ status, errors }` to refuse, or null for 204. */
export async function withApple(routes, work) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    const sent = init.body ? JSON.parse(init.body) : {};
    const call = { method: init.method ?? "GET", origin: target.origin, path: target.pathname, query: Object.fromEntries(target.searchParams),
      body: sent.data, included: sent.included, authorization: new Headers(init.headers).get("authorization"), cookie: new Headers(init.headers).get("cookie") };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    const result = typeof route === "function" ? route(call) : route;
    if (result === undefined) return Response.json({ errors: [{ status: "404", code: "NOT_FOUND", detail: `no route ${call.method} ${call.path}` }] }, { status: 404 });
    if (result === null) return new Response(null, { status: 204 });
    /* A route may also answer with headers, such as the cookies Apple's website rotates. */
    const { responseHeaders, ...document } = result;
    return Response.json(document, { status: result.status ?? 200, headers: responseHeaders ?? {} });
  };
  try { return { value: await work(), calls }; } finally { globalThis.fetch = original; }
}

/** What `@appstoreconnect:<action>:<target> <text>` parses to. */
export const statement = (body) => {
  const command = parseActionCommand("appstoreconnect", body);
  return ACTIONS[command.actionId].parse(command.statement);
};

/** Run one statement against the double. */
export const run = (routes, body, keys = credentials) => {
  const command = parseActionCommand("appstoreconnect", body);
  const action = ACTIONS[command.actionId];
  return withApple(routes, () => action.execute({ credentials: keys }, action.parse(command.statement)));
};

export const apps = { "GET /v1/apps": { data: [APP] } };
export const version = (id, versionString, state, build, createdDate = "2026-09-01T00:00:00Z") => ({ type: "appStoreVersions", id,
  attributes: { platform: "IOS", versionString, appVersionState: state, releaseType: "MANUAL", createdDate },
  relationships: { build: { data: build ? { type: "builds", id: build } : null } } });
export const versions = (...rows) => ({ "GET /v1/apps/6760000001/appStoreVersions": { data: rows,
  included: [{ type: "builds", id: "build-7", attributes: { version: "7", processingState: "VALID", expired: false } }] } });
export const writes = (calls) => calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`);
