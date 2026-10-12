import { record } from "../command-support";
import { providerJson, ProviderRequestError } from "../http";
import type { ConnectorAction, ConnectorActionStatement } from "../provider";
import { quoteRetrievedText } from "./common";
import { googleHeaders } from "./google-headers";
import { searchConsoleSite } from "./google-search-console-site";

const API = "https://www.googleapis.com/siteVerification/v1";
const SCOPE = "https://www.googleapis.com/auth/siteverification";
const DOMAIN_METHODS = new Set(["DNS_TXT", "DNS_CNAME"]);
const SITE_METHODS = new Set(["FILE", "META", "ANALYTICS", "TAG_MANAGER"]);

function headers(credentials: Readonly<Record<string, string>>): Record<string, string> {
  if (!credentials.oauthScopes?.split(/\s+/u).includes(SCOPE)) {
    throw new ProviderRequestError(403, "Reconnect Google Search Console to authorize site verification; existing Search Console actions still work");
  }
  return googleHeaders(credentials, "Google Search Console");
}

function verificationSite(statement: ConnectorActionStatement): Record<string, string> | string {
  const site = searchConsoleSite(statement.target);
  const method = statement.text.trim();
  if (!site || !(site.startsWith("sc-domain:") ? DOMAIN_METHODS : SITE_METHODS).has(method)) {
    return "use <sc-domain:example.com> DNS_TXT|DNS_CNAME or <https://example.com/> FILE|META|ANALYTICS|TAG_MANAGER";
  }
  return { identifier: site.startsWith("sc-domain:") ? site.slice(10) : site,
    type: site.startsWith("sc-domain:") ? "INET_DOMAIN" : "SITE", method };
}

function resourceId(statement: ConnectorActionStatement): Record<string, string> | string {
  const id = statement.target;
  return id && id !== "*" && id.length <= 2048 && !/\s/u.test(id) && !Array.from(id).some(char => char.charCodeAt(0) < 32) && !statement.text.trim()
    ? { id } : "name the exact verification resource id returned by list_verifications or verify_site";
}

function resourceUrl(id: string): string { return `${API}/webResource/${encodeURIComponent(id)}`; }

function resourceSummary(value: unknown): string {
  const resource = record(value);
  const site = record(resource.site);
  if (typeof resource.id !== "string" || !resource.id || !["SITE", "INET_DOMAIN"].includes(String(site.type)) ||
      typeof site.identifier !== "string" || !Array.isArray(resource.owners) || resource.owners.some(owner => typeof owner !== "string")) {
    throw new ProviderRequestError(502, "Google did not return a verified site resource");
  }
  return JSON.stringify({ id: resource.id, site, owners: resource.owners });
}

function resourceAction(method: "GET" | "DELETE"): ConnectorAction {
  return { effect: method === "GET" ? "read" : "write", requires: ["oauthToken"], parse: resourceId,
    async execute({ credentials }, input) {
      const result = await providerJson(resourceUrl(input.id!), { method, headers: headers(credentials) });
      if (method === "GET" && result.id !== input.id) throw new ProviderRequestError(502, "Google did not return the requested verification resource");
      return { summary: method === "DELETE" ? `Removed the connected account's ownership of verification resource ${input.id}.` :
        "Verified site:\n" + quoteRetrievedText(resourceSummary(result), 16_000) };
    } };
}

export const GOOGLE_SITE_VERIFICATION_ACTIONS: Record<string, ConnectorAction> = {
  get_verification_token: {
    effect: "read", requires: ["oauthToken"], parse: verificationSite,
    async execute({ credentials }, input) {
      const result = await providerJson(`${API}/token`, { method: "POST", headers: headers(credentials),
        json: { site: { type: input.type, identifier: input.identifier }, verificationMethod: input.method } });
      if (result.method !== input.method || typeof result.token !== "string" || !result.token || result.token.length > 8192) {
        throw new ProviderRequestError(502, "Google did not return the requested verification token");
      }
      return { summary: `Publish this ${input.method} verification token for ${input.identifier}, then call verify_site with the same method:\n` +
        quoteRetrievedText(result.token) };
    },
  },
  verify_site: {
    effect: "write", requires: ["oauthToken"], parse: verificationSite,
    async execute({ credentials }, input) {
      const result = await providerJson(`${API}/webResource?verificationMethod=${input.method}`, {
        method: "POST", headers: headers(credentials), json: { site: { type: input.type, identifier: input.identifier } } });
      const site = record(result.site);
      if (site.identifier !== input.identifier || site.type !== input.type) {
        throw new ProviderRequestError(502, "Google did not confirm the requested site's ownership");
      }
      return { summary: "Ownership verified; add the property with add_site if needed:\n" + quoteRetrievedText(resourceSummary(result), 16_000) };
    },
  },
  list_verifications: {
    effect: "read", requires: ["oauthToken"],
    parse: statement => statement.target === "*" && !statement.text.trim() ? {} : "use @googlesearchconsole:list_verifications:*",
    async execute({ credentials }) {
      const result = await providerJson(`${API}/webResource`, { headers: headers(credentials) });
      if (result.items !== undefined && !Array.isArray(result.items)) throw new ProviderRequestError(502, "Google did not return verified sites");
      const items = (result.items as unknown[] | undefined) ?? [];
      return { summary: `Verified resources (${items.length}; at most 50 shown):\n` +
        quoteRetrievedText(items.slice(0, 50).map(resourceSummary).join("\n") || "(no verified resources)", 16_000) };
    },
  },
  get_verification: resourceAction("GET"),
  delete_verification: resourceAction("DELETE"),
  update_verification_owners: {
    effect: "write", requires: ["oauthToken"],
    parse(statement) {
      const id = resourceId({ ...statement, text: "" });
      if (typeof id === "string" || statement.text.length > 8192) return "name an exact resource id and JSON {\"owners\":[\"email@example.com\"]}; replaces its owner list";
      let body: Record<string, unknown>;
      try { body = record(JSON.parse(statement.text)); } catch { return "owners must be a JSON object"; }
      const owners = body.owners;
      if (Object.keys(body).length !== 1 || !Array.isArray(owners) || !owners.length || owners.length > 50 ||
          new Set(owners).size !== owners.length || owners.some(owner => typeof owner !== "string" ||
            owner.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(owner))) return "supply 1-50 distinct owner emails in {\"owners\":[...]}";
      return { ...id, owners: JSON.stringify(owners) };
    },
    async execute({ credentials }, input) {
      const result = await providerJson(resourceUrl(input.id!), { method: "PUT", headers: headers(credentials),
        json: { owners: JSON.parse(input.owners!) } });
      if (result.id !== input.id) throw new ProviderRequestError(502, "Google did not return the requested verification resource");
      return { summary: "Updated the verification owner list:\n" + quoteRetrievedText(resourceSummary(result), 16_000) };
    },
  },
};
