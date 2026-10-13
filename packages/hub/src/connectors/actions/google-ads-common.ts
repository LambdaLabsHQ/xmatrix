import { record } from "../command-support";
import { describeGoogleError } from "../google-provider-error";
import { providerJson, ProviderRequestError } from "../http";
import { googleHeaders } from "./google-headers";

// Google Ads API access belongs to the OAuth client's Cloud project. Developer
// tokens were retired in September 2026; never send one or use a different client.
const API = "https://googleads.googleapis.com/v25";
export const ADS_ROW_LIMIT = 250;

export function adsCustomerId(value: string): string | undefined {
  return /^(?:\d{10}|\d{3}-\d{3}-\d{4})$/u.test(value) ? value.replaceAll("-", "") : undefined;
}

export function adsCustomer(credentials: Readonly<Record<string, string>>, requested?: string): string {
  const customer = adsCustomerId(credentials.customerId ?? "");
  if (!customer) throw new ProviderRequestError(400, "Save the selected Google Ads customer ID in Apps → Google Ads → Credentials");
  if (requested !== undefined && requested !== customer) {
    throw new ProviderRequestError(403, "This Google Ads connection is restricted to its selected customer ID");
  }
  return customer;
}

function adsError(payload: Record<string, unknown>): string {
  const error = record(payload.error);
  const details = Array.isArray(error.details) ? error.details : [];
  const failure = details.map(record).find(detail =>
    detail["@type"] === "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure");
  const codes = (Array.isArray(failure?.errors) ? failure.errors : []).flatMap(value =>
    Object.values(record(record(value).errorCode)).filter(code => typeof code === "string" && /^[A-Z_]{1,80}$/u.test(code)));
  return [...new Set([describeGoogleError(payload), ...codes])].slice(0, 4).join("; ");
}

export async function adsRequest(credentials: Readonly<Record<string, string>>, path: string, json?: unknown):
  Promise<Record<string, unknown>> {
  const headers = googleHeaders(credentials, "Google Ads");
  if (credentials.loginCustomerId) {
    const manager = adsCustomerId(credentials.loginCustomerId);
    if (!manager) throw new ProviderRequestError(400, "Google Ads login customer ID must be a ten-digit manager ID");
    headers["login-customer-id"] = manager;
  }
  return providerJson(`${API}/${path}`, { headers, ...(json === undefined ? {} : { method: "POST", json }),
    describeError: adsError });
}

export function adsQuery(input: string): string | undefined {
  const query = input.trim();
  if (!query || query.length > 8_000 || !/^SELECT\s/iu.test(query) || /;|\/\*|\*\/|--/u.test(query) ||
      Array.from(query).some(character => character.codePointAt(0)! < 32 && !["\n", "\r", "\t"].includes(character))) return undefined;
  const limit = query.match(/\sLIMIT\s+(\d+)\s*$/iu);
  if (limit && (!Number.isSafeInteger(Number(limit[1])) || Number(limit[1]) < 1 || Number(limit[1]) > ADS_ROW_LIMIT)) return undefined;
  // Google owns GAQL parsing. A malformed earlier LIMIT remains invalid; it
  // cannot remove this final bound. Search's fixed API page size is not a bound.
  return limit ? query : `${query}\nLIMIT ${ADS_ROW_LIMIT}`;
}

export async function adsSearch(credentials: Readonly<Record<string, string>>, customer: string, query: string): Promise<unknown[]> {
  adsCustomer(credentials, customer);
  const payload = await adsRequest(credentials, `customers/${customer}/googleAds:search`, { query });
  const results = payload.results ?? [];
  if (!Array.isArray(results) || results.length > ADS_ROW_LIMIT) {
    throw new ProviderRequestError(502, "Google Ads did not return a bounded search result");
  }
  return results;
}

export async function adsAccount(credentials: Readonly<Record<string, string>>, customer: string): Promise<Record<string, unknown>> {
  const rows = await adsSearch(credentials, customer, "SELECT customer.id, customer.resource_name, customer.descriptive_name, " +
    "customer.currency_code, customer.time_zone, customer.manager, customer.test_account FROM customer LIMIT 1");
  const account = record(record(rows[0]).customer);
  if (String(account.id ?? "") !== customer || typeof account.currencyCode !== "string" ||
      !/^[A-Z]{3}$/u.test(account.currencyCode) || typeof account.timeZone !== "string" ||
      account.resourceName !== `customers/${customer}`) {
    throw new ProviderRequestError(502, "Google Ads did not confirm the selected customer, currency and time zone");
  }
  return account;
}

export function adsMicros(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,19}$/u.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
}

export function adsCurrency(account: Record<string, unknown>, currency: string | undefined): void {
  if (currency !== account.currencyCode) {
    throw new ProviderRequestError(409, "Google Ads currency does not match the requested account currency; read_account before changing budgets");
  }
}

/** Exactly one atomic request. An uncertain write is never automatically retried. */
export async function adsMutate(credentials: Readonly<Record<string, string>>, customer: string,
  operations: Record<string, unknown>[], validateOnly: boolean): Promise<string[]> {
  adsCustomer(credentials, customer);
  let payload: Record<string, unknown>;
  try {
    payload = await adsRequest(credentials, `customers/${customer}/googleAds:mutate`, {
      mutateOperations: operations, partialFailure: false, validateOnly, responseContentType: "RESOURCE_NAME_ONLY",
    });
  } catch (error) {
    if (!validateOnly && (!(error instanceof ProviderRequestError) || error.status >= 500)) {
      throw new ProviderRequestError(502, "Google Ads mutation outcome is unconfirmed; query the account before repeating this request");
    }
    throw error;
  }
  if (Number(record(payload.partialFailureError).code ?? 0) !== 0) {
    throw new ProviderRequestError(502, "Google Ads did not confirm an atomic mutation; query the account before repeating it");
  }
  if (validateOnly) return [];
  const results = payload.mutateOperationResponses;
  if (!Array.isArray(results) || results.length !== operations.length) {
    throw new ProviderRequestError(502, "Google Ads mutation receipts are incomplete; query the account before repeating it");
  }
  return results.map((value, index) => {
    const type = Object.keys(operations[index]!)[0]!.replace(/Operation$/u, "Result");
    const name = record(record(value)[type]).resourceName;
    if (typeof name !== "string" || !name.startsWith(`customers/${customer}/`)) {
      throw new ProviderRequestError(502, "Google Ads returned an unexpected mutation destination; query the account before repeating it");
    }
    return name;
  });
}
