import { record } from "../command-support";
import { ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { quoteRetrievedText } from "./common";
import { adsAccount, adsCustomer, adsCustomerId, adsQuery, adsRequest, adsSearch } from "./google-ads-common";
import { GOOGLE_ADS_MUTATION_ACTIONS } from "./google-ads-mutations";

const REQUIRES = ["oauthToken", "customerId"];

export const GOOGLE_ADS_ACTIONS: Record<string, ConnectorAction> = {
  list_accounts: {
    effect: "read", requires: ["oauthToken"],
    parse: statement => statement.target === "*" && !statement.text.trim() ? {} : "use @googleads:list_accounts:*",
    async execute({ credentials }) {
      const payload = await adsRequest(credentials, "customers:listAccessibleCustomers");
      const names = payload.resourceNames;
      if (!Array.isArray(names) || names.some(name => typeof name !== "string" || !/^customers\/\d{10}$/u.test(name))) {
        throw new ProviderRequestError(502, "Google Ads did not return accessible customer IDs");
      }
      return { summary: `Google Ads directly accessible accounts (${names.length}; first 100 shown). This list does not traverse manager accounts; ` +
        "actions stay restricted to the customer ID selected in this connection:\n" + quoteRetrievedText(names.slice(0, 100).join("\n") || "(none)") };
    },
  },
  read_account: {
    effect: "read", requires: REQUIRES,
    parse: statement => adsCustomerId(statement.target) && !statement.text.trim()
      ? { customer: adsCustomerId(statement.target)! } : "name the Google Ads customer ID",
    async execute({ credentials }, input) {
      const account = await adsAccount(credentials, input.customer!);
      return { summary: "Google Ads selected account (amounts are in its currency and report dates use its time zone):\n" +
        quoteRetrievedText(JSON.stringify(account, null, 2)) };
    },
  },
  query: {
    effect: "read", requires: REQUIRES,
    parse(statement) {
      const customer = adsCustomerId(statement.target), query = adsQuery(statement.text);
      return customer && query ? { customer, query } : "name the customer ID and a SELECT GAQL query; LIMIT must be 1-250 (default 250)";
    },
    async execute({ credentials }, input) {
      const rows = await adsSearch(credentials, input.customer!, input.query!);
      return { summary: `Google Ads query (${rows.length} rows; monetary Micros fields are integer millionths of the account currency; ` +
        "dates use the account time zone; reports may still be processing):\n" + quoteRetrievedText(JSON.stringify(rows, null, 2), 16_000) };
    },
  },
  ...GOOGLE_ADS_MUTATION_ACTIONS,
};

/** Native Check proves this exact customer is accessible; listing another account is not enough. */
export async function verifyGoogleAds(credentials: Readonly<Record<string, string>>): Promise<void> {
  const account = await adsAccount(credentials, adsCustomer(credentials));
  if (record(account).manager !== false) throw new ProviderRequestError(400, "Select an advertiser customer ID, not a Google Ads manager account");
}
