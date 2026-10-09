import { sign } from "node:crypto";
import { readFileSync } from "node:fs";

const ORIGIN = "https://api.appstoreconnect.apple.com";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Apple responses may contain review credentials or reflect submitted values.
// Never include response bodies, URLs, request bodies, or native error messages.
export class AppleApiError extends Error {
  constructor(status) {
    super(`App Store Connect request failed (HTTP ${status}). Inspect the private app record for details.`);
    this.status = status;
  }
}

export function appleToken({ keyId, issuerId, privateKey, now = Date.now() }) {
  if (!keyId || !issuerId || !privateKey) throw new Error("Missing App Store Connect API credentials.");
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const issued = Math.floor(now / 1000);
  const input = `${encode({ alg: "ES256", kid: keyId, typ: "JWT" })}.${encode({
    iss: issuerId, iat: issued - 10, exp: issued + 600, aud: "appstoreconnect-v1",
  })}`;
  try {
    return `${input}.${sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  } catch {
    throw new Error("Unable to sign App Store Connect request.");
  }
}

async function responseJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Invalid App Store Connect response.");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error("limit"); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { throw new Error("Invalid or oversized App Store Connect response."); }
  finally { reader.releaseLock(); }
}

export function appleClient({ keyId, issuerId, privateKey, fetchImpl = fetch, wait = sleep }) {
  const request = async (path, method = "GET", data) => {
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || !url.pathname.startsWith("/v1/") || url.username || url.password || url.hash) {
      throw new Error("Rejected App Store Connect destination.");
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetchImpl(url.href, {
          method, redirect: "error", signal: AbortSignal.timeout(30_000),
          headers: { Authorization: `Bearer ${appleToken({ keyId, issuerId, privateKey })}`, "Content-Type": "application/json" },
          ...(data === undefined ? {} : { body: JSON.stringify({ data }) }),
        });
      } catch {
        throw new Error("App Store Connect transport failed; rerun to reconcile remote state.");
      }
      if (method === "GET" && (response.status === 429 || response.status >= 500) && attempt < 2) {
        await response.body?.cancel();
        await wait((attempt + 1) * 1000);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppleApiError(response.status);
      }
      if (response.status === 204) return null;
      return responseJson(response);
    }
    throw new Error("App Store Connect retry limit reached.");
  };
  const list = async (path) => {
    const rows = [];
    for (let page = 0; path && page < 10; page++) {
      const response = await request(path);
      if (!Array.isArray(response.data)) throw new Error("Invalid App Store Connect collection.");
      rows.push(...response.data);
      path = response.links?.next;
    }
    if (path) throw new Error("App Store Connect pagination limit reached.");
    return rows;
  };
  return { request, list };
}

export function appleClientFromEnv(env) {
  let privateKey;
  try { privateKey = readFileSync(env.ASC_P8_PATH, "utf8"); } catch { throw new Error("App Store Connect private key is unavailable."); }
  return appleClient({ keyId: env.ASC_API_KEY_ID, issuerId: env.ASC_API_ISSUER_ID, privateKey });
}
