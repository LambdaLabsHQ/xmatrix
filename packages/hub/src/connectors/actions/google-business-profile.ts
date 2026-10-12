import { record } from "../command-support";
import { providerJson, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { googleHeaders } from "./google-headers";
import { quoteRetrievedText } from "./common";
import { cell, isoDate, keyedOptions, trailingDays } from "./google-report";

/*
 * Google Business Profile. The grant is the single `business.manage` scope,
 * Google's only scope for these APIs; reads use the Account Management,
 * Business Information and Performance APIs, and reviews the My Business v4
 * API, which is still their only home. A Google Cloud project must be
 * approved for Business Profile API access before any call succeeds.
 */

const ACCOUNTS = "https://mybusinessaccountmanagement.googleapis.com/v1";
const INFORMATION = "https://mybusinessbusinessinformation.googleapis.com/v1";
const PERFORMANCE = "https://businessprofileperformance.googleapis.com/v1";
const REVIEWS = "https://mybusiness.googleapis.com/v4";
const SERVICE = "Google Business Profile";
const ACCOUNT = /^accounts\/\d{1,30}$/u;
const LOCATION = /^(accounts\/\d{1,30})\/(locations\/\d{1,30})$/u;
const REVIEW = /^(accounts\/\d{1,30}\/locations\/\d{1,30})\/reviews\/([A-Za-z0-9_-]{1,200})$/u;
const METRICS = ["BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "WEBSITE_CLICKS", "CALL_CLICKS", "BUSINESS_DIRECTION_REQUESTS"];
const MAX_ROWS = 100;
const MAX_REPLY = 4_096;
const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

function headers(credentials: Readonly<Record<string, string>>): Record<string, string> {
  return googleHeaders(credentials, SERVICE);
}

function list(value: unknown, what: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ProviderRequestError(502, `Google did not return ${what}`);
  return value.map(record);
}

/** `accounts/1/locations/2`: the account names the v4 review path; the Performance API wants the bare location. */
function locationOnly(statement: { target: string; text: string }, usage: string): Record<string, string> | string {
  const match = statement.target.match(LOCATION);
  return match ? { account: match[1]!, location: match[2]! } : usage;
}

export const GOOGLE_BUSINESS_PROFILE_ACTIONS: Record<string, ConnectorAction> = {
  list_accounts: {
    effect: "read", requires: ["oauthToken"],
    parse: statement => statement.target === "*" && !statement.text.trim() ? {} : "use @googlebusinessprofile:list_accounts:*",
    async execute({ credentials }) {
      const result = await providerJson(`${ACCOUNTS}/accounts?pageSize=20`, { headers: headers(credentials) });
      const lines = list(result.accounts, "a Business Profile account list")
        .map(account => [cell(account.name), cell(account.accountName), cell(account.type), cell(account.role)].join("\t"));
      return { summary: "Business Profile accounts (name, account name, type, your role):\n" +
        quoteRetrievedText(lines.join("\n") || "(no Business Profile accounts for the connected Google account)") };
    },
  },
  list_locations: {
    effect: "read", requires: ["oauthToken"],
    parse: statement => ACCOUNT.test(statement.target) && !statement.text.trim() ? { account: statement.target } : "name an account: accounts/123",
    async execute({ credentials }, input) {
      const url = new URL(`${INFORMATION}/${input.account}/locations`);
      url.searchParams.set("readMask", "name,title,storefrontAddress,websiteUri,metadata");
      url.searchParams.set("pageSize", String(MAX_ROWS));
      const result = await providerJson(url, { headers: headers(credentials) });
      const lines = list(result.locations, "a location list").map(location => {
        const address = record(location.storefrontAddress);
        const street = Array.isArray(address.addressLines) ? address.addressLines.map(cell).join(", ") : "";
        return [`${input.account}/${cell(location.name)}`, cell(location.title), [street, cell(address.locality)].filter(Boolean).join(", "),
          cell(location.websiteUri), cell(record(location.metadata).mapsUri)].join("\t");
      });
      return { summary: `Locations of ${input.account} (location, title, address, website, Maps):\n` +
        quoteRetrievedText(lines.join("\n") || "(no locations)") };
    },
  },
  performance: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      const usage = "name a location and a range: accounts/1/locations/2 [days=1-540]";
      const target = locationOnly(statement, usage);
      const options = keyedOptions(statement.text, ["days"], usage);
      if (typeof target === "string" || typeof options === "string") return usage;
      const days = Number(options.get("days") ?? "28");
      return Number.isSafeInteger(days) && days >= 1 && days <= 540 ? { ...target, days: String(days) } : usage;
    },
    async execute({ credentials }, input, now = Date.now()) {
      // Google's numbers lag a few days; the range ends three days ago.
      const { start, end } = trailingDays(Number(input.days), now - 3 * 86_400_000);
      const url = new URL(`${PERFORMANCE}/${input.location}:fetchMultiDailyMetricsTimeSeries`);
      for (const metric of METRICS) url.searchParams.append("dailyMetrics", metric);
      for (const [prefix, day] of [["dailyRange.start_date", start], ["dailyRange.end_date", end]] as const) {
        const date = new Date(day);
        url.searchParams.set(`${prefix}.year`, String(date.getUTCFullYear()));
        url.searchParams.set(`${prefix}.month`, String(date.getUTCMonth() + 1));
        url.searchParams.set(`${prefix}.day`, String(date.getUTCDate()));
      }
      const result = await providerJson(url, { headers: headers(credentials) });
      const totals = new Map<string, number>();
      for (const group of list(result.multiDailyMetricTimeSeries, "performance metrics")) {
        for (const series of list(group.dailyMetricTimeSeries, "performance metrics")) {
          const values = list(record(series.timeSeries).datedValues, "performance metrics");
          totals.set(String(series.dailyMetric), values.reduce((sum, value) => sum + Number(value.value ?? 0), 0));
        }
      }
      const lines = METRICS.map(metric => `${metric.toLowerCase()}\t${totals.get(metric) ?? 0}`);
      return { summary: `Business Profile performance for ${input.account}/${input.location}, ${isoDate(start)} to ${isoDate(end)}:\n` +
        quoteRetrievedText(lines.join("\n")) };
    },
  },
  reviews: {
    effect: "read", requires: ["oauthToken"],
    parse: statement => statement.text.trim() ? "name a location: accounts/1/locations/2" : locationOnly(statement, "name a location: accounts/1/locations/2"),
    async execute({ credentials }, input) {
      const result = await providerJson(`${REVIEWS}/${input.account}/${input.location}/reviews?pageSize=50&orderBy=updateTime%20desc`,
        { headers: headers(credentials) });
      const lines = list(result.reviews, "reviews").map(review => [cell(review.name), Object.hasOwn(STARS, String(review.starRating)) ? STARS[String(review.starRating)] : "-",
        cell(review.updateTime).slice(0, 10), review.reviewReply ? "replied" : "no reply", cell(record(review.reviewer).displayName),
        cell(review.comment)].join("\t"));
      return { summary: `Newest reviews of ${input.account}/${input.location} (average ${cell(result.averageRating)} from ` +
        `${cell(result.totalReviewCount)}; review, stars, updated, reply, reviewer, text):\n` + quoteRetrievedText(lines.join("\n") || "(no reviews)") };
    },
  },
  reply_review: {
    effect: "write", requires: ["oauthToken"],
    parse(statement) {
      const comment = statement.text.trim();
      return REVIEW.test(statement.target) && comment && comment.length <= MAX_REPLY ? { review: statement.target, comment }
        : `name a review and the reply text (at most ${MAX_REPLY} characters): accounts/1/locations/2/reviews/<id> <reply>`;
    },
    async execute({ credentials }, input) {
      await providerJson(`${REVIEWS}/${input.review}/reply`, { method: "PUT", headers: headers(credentials), json: { comment: input.comment } });
      return { summary: `Posted the public reply to ${input.review}; it replaces any earlier reply.` };
    },
  },
};

/** Confirm the grant with a real read; the account list is not stored. */
export async function verifyGoogleBusinessProfile(credentials: Readonly<Record<string, string>>): Promise<void> {
  list((await providerJson(`${ACCOUNTS}/accounts?pageSize=1`, { headers: headers(credentials) })).accounts, "Business Profile access");
}
