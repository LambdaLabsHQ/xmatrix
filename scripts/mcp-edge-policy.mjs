import { isDeepStrictEqual } from "node:util";

import { runCliMain } from "./cli-entrypoint.mjs";

const API = "https://api.cloudflare.com/client/v4";
const PHASE = "http_request_firewall_custom";
const REF = "xmatrix_mcp_bic_compatibility";

function origin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.pathname !== "/" || url.search || url.hash ||
      !/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/u.test(url.hostname)) {
    throw new Error("MCP edge policy requires plain HTTPS deployment origins");
  }
  return url;
}

function desiredRule(host) {
  return {
    ref: REF,
    description: "Allow non-browser MCP clients through Browser Integrity Check",
    expression: `(http.host eq "${host}" and http.request.uri.path eq "/mcp")`,
    action: "skip",
    action_parameters: { products: ["bic"] },
    enabled: true,
    logging: { enabled: true },
  };
}

function ownedRule(ruleset, expected) {
  if (!ruleset) return null;
  if (ruleset.kind !== "zone" || ruleset.phase !== PHASE || !Array.isArray(ruleset.rules)) {
    throw new Error("MCP edge policy received an unexpected ruleset");
  }
  const owned = ruleset.rules.filter(rule => rule.ref === REF);
  if (owned.length > 1) throw new Error("MCP edge policy has duplicate owned rules");
  const rule = owned[0];
  if (rule && (rule.expression !== expected.expression || rule.action !== "skip" ||
      rule.enabled !== true || !isDeepStrictEqual(rule.action_parameters, expected.action_parameters) ||
      rule.logging?.enabled !== true)) {
    throw new Error("MCP edge policy differs from the reviewed BIC-only rule; refusing to overwrite it");
  }
  return rule ?? null;
}

/** One additive, exact-host BIC exception; no replacement of existing rules. */
export async function ensureMcpEdgePolicy({ accountId, token, hubOrigin, appOrigin, fetchImpl = fetch }) {
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "") || !token?.trim()) {
    throw new Error("MCP edge policy requires the production Cloudflare account and token");
  }
  const hub = origin(hubOrigin), app = origin(appOrigin);
  if (hub.hostname !== app.hostname && !hub.hostname.endsWith(`.${app.hostname}`)) {
    throw new Error("MCP Hub must belong to the production Web zone");
  }
  const request = async (path, method = "GET", body, missing = false) => {
    const signal = AbortSignal.timeout(20_000);
    let response, decoded;
    try {
      response = await fetchImpl(`${API}${path}`, {
        method, signal, redirect: "error",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (missing && response.status === 404) { await response.body?.cancel(); return null; }
      decoded = await response.json();
    } catch {
      throw new Error(`MCP edge Cloudflare ${method} failed during transport or decoding`);
    }
    if (!response.ok || decoded.success !== true) {
      throw new Error(`MCP edge Cloudflare ${method} refused (HTTP ${response.status}); verify existing token permissions`);
    }
    return decoded.result;
  };
  // Read the domain just attached by this account's tagged Worker deployment.
  // This uses its existing Workers grant, without adding Zone Read privileges.
  const query = new URLSearchParams({ hostname: hub.hostname });
  const domains = await request(`/accounts/${accountId}/workers/domains?${query}`);
  if (!Array.isArray(domains) || domains.length !== 1 || domains[0].hostname !== hub.hostname ||
      domains[0].zone_name !== app.hostname || !/^[a-f0-9]{32}$/u.test(domains[0].zone_id ?? "")) {
    throw new Error("MCP edge policy could not identify exactly one deployment-owned zone");
  }
  const zoneId = domains[0].zone_id;
  const base = `/zones/${zoneId}/rulesets`;
  const entrypoint = `${base}/phases/${PHASE}/entrypoint`;
  const expected = desiredRule(hub.hostname);
  const before = await request(entrypoint, "GET", undefined, true);
  let rule = ownedRule(before, expected);
  if (!rule) {
    if (before && !/^[a-f0-9]{32}$/u.test(before.id ?? "")) {
      throw new Error("MCP edge policy received an invalid ruleset id");
    }
    let mutationError;
    try {
      if (before) await request(`${base}/${before.id}/rules`, "POST", expected);
      else await request(base, "POST", {
        name: "MCP browser compatibility", kind: "zone", phase: PHASE, rules: [expected],
      });
    } catch (error) { mutationError = error; }
    // A lost response may follow a committed create. Read back once instead of
    // blindly repeating it; a subsequent release retry finds the same ref.
    rule = ownedRule(await request(entrypoint, "GET", undefined, true), expected);
    if (!rule) throw mutationError ?? new Error("MCP edge policy was not present after creation");
  }
  if (!/^[a-f0-9]{32}$/u.test(rule.id ?? "")) throw new Error("MCP edge policy has no verified rule id");
  return { zoneId, ruleId: rule.id, ref: REF };
}

/** An anonymous Python-style client must reach OAuth, never bypass it. */
export async function verifyMcpEdgeAccess(hubOrigin, { fetchImpl = fetch, attempts = 6 } = {}) {
  const hub = origin(hubOrigin);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 6) throw new Error("Invalid MCP probe bound");
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetchImpl(new URL("/mcp", hub), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Python-urllib/3.12", "Content-Type": "application/json",
        Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const challenge = response.headers.get("www-authenticate") ?? "";
    await response.body?.cancel();
    if (response.status === 401 && challenge.startsWith("Bearer ") &&
        challenge.includes(`resource_metadata="${hub.origin}/.well-known/oauth-protected-resource/mcp"`)) return;
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error("Python-style MCP client did not reach the Hub OAuth challenge");
}

runCliMain(import.meta.url, async () => {
  const result = await ensureMcpEdgePolicy({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN, hubOrigin: process.env.XMATRIX_HUB_ORIGIN,
    appOrigin: process.env.XMATRIX_APP_ORIGIN });
  console.log(`Verified MCP BIC-only rule ${result.ref} (${result.ruleId}) in zone ${result.zoneId}`);
  await verifyMcpEdgeAccess(process.env.XMATRIX_HUB_ORIGIN);
  console.log("Anonymous Python-style MCP client reaches the Hub OAuth challenge");
});
