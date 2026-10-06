import { APP_CONNECTOR_PROVIDER_MANIFESTS } from "../../../protocol/src/app-connector-manifests.ts";
// The Hub's GitHub App, stubbed at `fetch`: a throwaway signing key, a Space's
// GitHub connection, and a recorder for the GitHub REST calls the Hub makes.

/** A throwaway GitHub App signing key. */
export async function githubAppPrivateKey() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`;
}

/** The Hub environment of a GitHub App signing with a throwaway key. */
export async function githubAppEnv() {
  return { GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: await githubAppPrivateKey() };
}

/** space-1's configured GitHub connection, through installation 777 unless overridden. */
export function githubConnection(overrides = {}) {
  return {
    id: "space-1:github",
    providerId: "github",
    providerName: "GitHub",
    status: "configured",
    metadata: { installationIds: ["777"] },
    ...overrides,
  };
}

export function jsonResponse(payload, status = 200) {
  return new Response(payload === undefined ? null : JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Answer every `fetch` with `handler`, recording each call so a test can assert on it. */
export function stubGitHubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const call = {
      url,
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** The context of an `@github:<action>` mention a Human posted in channel-1 of space-1. */
export function githubActionContext(env, { actionId, actionLabel, body, connection = githubConnection() }) {
  return {
    env,
    mention: {
      token: `@github:${actionId}`,
      appId: "github",
      appName: "GitHub",
      status: "available",
      actionId,
      ...(actionLabel ? { actionLabel } : {}),
    },
    message: { messageId: "message-1", channelId: "channel-1", body },
    connection,
  };
}

/** The real provider catalog, shared by action contract tests. */
export function githubProviderManifest() {
  return APP_CONNECTOR_PROVIDER_MANIFESTS.find(provider => provider.id === "github");
}

/** Installation lookup and token minting for the configured test installation. */
export function stubGitHubInstallation(permissions, handler, tokenFields = { token: "ghs_scoped" }) {
  return stubGitHubFetch(call => {
    if (call.url.endsWith("/installation")) return jsonResponse({ id: 777 });
    if (call.url.includes("/access_tokens")) return jsonResponse({ ...tokenFields, permissions });
    return handler(call);
  });
}
