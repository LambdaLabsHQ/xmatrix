import { appStoreConnect, appleApp } from "../app-store-connect-api";
import { record, text } from "../event-format";
import { ConnectorRemedy, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { webSession } from "../app-store-connect-web";
import { bundleId } from "./app-store-connect";
import { quoteRetrievedText } from "./common";
import { isoDate, keyedOptions } from "./google-report";

/*
 * Sales and Trends (`GET /v1/salesReports`, report SALES / SUMMARY 1_0): the
 * downloads, redownloads, updates and in-app purchases Apple counted, per day
 * or per month. Apple names a team's reports by its vendor number (Payments
 * and Financial Reports, top left), which no API returns: the first
 * statement names it and the connection keeps it, so later ones need not.
 * With a saved web session it is read from the website's Payments page
 * instead (the provider's SAP vendor numbers), so nobody has to type it. Each period is one gzipped tab-separated file; a period with no
 * sales is a 404. Days follow Apple's Pacific-time report day, and a day's
 * report appears the next morning; a month's appears after the month ends.
 */

const VENDOR = /^\d{6,12}$/u;
const DAY_MS = 86_400_000;
const MAX_DAYS = 31;
const MAX_MONTHS = 12;
const PARALLEL = 6;
const TOP_COUNTRIES = 10;
const USAGE = "use <com.example.app|*> [vendor=<vendor number>] [by=day|month] [days=1-31] [months=1-12]";

/* Apple's product type identifiers (Sales and Trends reference, "Product Type Identifiers"). */
const DOWNLOAD = new Set(["1", "1F", "1T", "F1", "1E", "1EP", "1EU"]);
const REDOWNLOAD = new Set(["3", "3F", "3T", "F3"]);
const UPDATE = new Set(["7", "7F", "7T", "F7"]);
const inApp = (type: string) => type.startsWith("IA") || type === "FI1";

interface SalesOptions { vendor?: string; frequency: "DAILY" | "MONTHLY"; periods: string[] }

/** The report periods, newest first: whole days ending yesterday (UTC), or whole months ending last month. */
export function salesOptions(input: string, now = Date.now()): SalesOptions | string {
  const options = keyedOptions(input, ["vendor", "by", "days", "months"], USAGE);
  if (typeof options === "string") return options;
  const vendor = options.get("vendor");
  if (vendor !== undefined && !VENDOR.test(vendor)) return `vendor is the number from Payments and Financial Reports: ${USAGE}`;
  const by = options.get("by") ?? (options.has("months") ? "month" : "day");
  if (by !== "day" && by !== "month") return "by is day or month";
  if (by === "day" ? options.has("months") : options.has("days")) return by === "day" ? "months goes with by=month" : "days goes with by=day";
  const count = Number(options.get(by === "day" ? "days" : "months") ?? (by === "day" ? "14" : "6"));
  const maximum = by === "day" ? MAX_DAYS : MAX_MONTHS;
  if (!Number.isSafeInteger(count) || count < 1 || count > maximum) return `${by === "day" ? "days" : "months"} is a whole number from 1 to ${maximum}`;
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const periods = by === "day"
    ? Array.from({ length: count }, (_, index) => isoDate(today - (index + 1) * DAY_MS))
    : Array.from({ length: count }, (_, index) => {
      const month = new Date(today);
      month.setUTCDate(1);
      month.setUTCMonth(month.getUTCMonth() - index - 1);
      return month.toISOString().slice(0, 7);
    });
  return { ...(vendor ? { vendor } : {}), frequency: by === "day" ? "DAILY" : "MONTHLY", periods };
}

interface Tally { downloads: number; redownloads: number; updates: number; inApp: number }
const empty = (): Tally => ({ downloads: 0, redownloads: 0, updates: 0, inApp: 0 });

interface SalesSummary { periods: Array<{ period: string; tally?: Tally }>; total: Tally;
  countries: Map<string, number>; proceeds: Map<string, number> }

/** Count one report's rows that belong to the app (by Apple ID, or an in-app purchase by its parent's SKU), or every row. */
function tallyReport(tsv: string, app: { id: string; sku: string } | undefined,
  into: { tally: Tally; countries: Map<string, number>; proceeds: Map<string, number> }): void {
  const [head = "", ...lines] = tsv.split(/\r?\n/u);
  const columns = head.split("\t").map(name => name.trim());
  const at = (name: string) => columns.indexOf(name);
  const type = at("Product Type Identifier"), units = at("Units"), apple = at("Apple Identifier"), parent = at("Parent Identifier");
  const country = at("Country Code"), proceeds = at("Developer Proceeds"), currency = at("Currency of Proceeds");
  if (type < 0 || units < 0 || apple < 0) throw new ProviderRequestError(502, "App Store Connect returned a sales report without the expected columns");
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = line.split("\t");
    if (app && cells[apple]?.trim() !== app.id && !(app.sku && parent >= 0 && cells[parent]?.trim() === app.sku)) continue;
    const kind = cells[type]?.trim() ?? "", count = Number(cells[units]) || 0;
    if (DOWNLOAD.has(kind)) {
      into.tally.downloads += count;
      const code = country >= 0 ? cells[country]?.trim() : "";
      if (code) into.countries.set(code, (into.countries.get(code) ?? 0) + count);
    } else if (REDOWNLOAD.has(kind)) into.tally.redownloads += count;
    else if (UPDATE.has(kind)) into.tally.updates += count;
    else if (inApp(kind)) into.tally.inApp += count;
    const earned = (Number(cells[proceeds]) || 0) * count, unit = currency >= 0 ? cells[currency]?.trim() : "";
    if (earned && unit) into.proceeds.set(unit, (into.proceeds.get(unit) ?? 0) + earned);
  }
}

/** Every 6–12 digit value under a key that names a vendor, anywhere in the website's answer. */
function vendorNumbers(value: unknown, key = ""): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap(item => vendorNumbers(item, key)))];
  if (value && typeof value === "object") {
    return [...new Set(Object.entries(value).flatMap(([name, item]) => vendorNumbers(item, /vendor/iu.test(name) ? name : key)))];
  }
  const number = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  return key && VENDOR.test(number) ? [number] : [];
}

/** The vendor numbers the website's Payments page lists for the team; none without a working web session. */
async function websiteVendor(context: Parameters<ConnectorAction["execute"]>[0]): Promise<string[]> {
  if (!context.credentials.webSession) return [];
  const session = webSession(context);
  try {
    const provider = record((await session.read("/olympus/v1/session")).provider);
    const id = text(provider.providerId) || (typeof provider.providerId === "number" ? String(provider.providerId) : "");
    if (!/^\d{1,20}$/u.test(id)) return [];
    return vendorNumbers(await session.read(`/WebObjects/iTunesConnect.woa/ra/paymentConsolidation/providers/${id}/sapVendorNumbers`));
  } catch { return []; } finally { await session.settle(); }
}

const row = (label: string, tally: Tally) => [label, tally.downloads, tally.redownloads, tally.updates, tally.inApp].join("\t");

function salesText(summary: SalesSummary, frequency: SalesOptions["frequency"]): string {
  const lines = [`${frequency === "DAILY" ? "day" : "month"}\tdownloads\tredownloads\tupdates\tin-app units`,
    ...summary.periods.map(({ period, tally }) => tally ? row(period, tally) : `${period}\t(no report)`), row("TOTAL", summary.total)];
  const countries = [...summary.countries].filter(([, count]) => count).sort((a, b) => b[1] - a[1]).slice(0, TOP_COUNTRIES);
  if (countries.length) lines.push("", `downloads by country (top ${TOP_COUNTRIES}): ${countries.map(([code, count]) => `${code} ${count}`).join(", ")}`);
  const proceeds = [...summary.proceeds].filter(([, amount]) => Math.abs(amount) >= 0.005);
  if (proceeds.length) lines.push(`developer proceeds: ${proceeds.map(([unit, amount]) => `${amount.toFixed(2)} ${unit}`).join(", ")}`);
  return lines.join("\n");
}

export const APP_STORE_CONNECT_SALES_ACTIONS: Record<string, ConnectorAction> = {
  sales: {
    effect: "read", requires: ["keyId", "privateKey"],
    parse(statement) {
      const app = statement.target === "*" ? "*" : bundleId(statement.target);
      if (!app) return USAGE;
      const options = salesOptions(statement.text);
      return typeof options === "string" ? options : { app, options: JSON.stringify(options) };
    },
    async execute(context, input) {
      const { credentials, saveCredentials } = context;
      const options = JSON.parse(input.options!) as SalesOptions;
      const saved = credentials.vendorNumber?.trim() ?? "";
      let vendor = options.vendor ?? (VENDOR.test(saved) ? saved : "");
      if (!vendor) {
        const found = await websiteVendor(context);
        if (found.length === 1) vendor = found[0]!;
        else {
          throw new ConnectorRemedy(400, found.length
            ? `The team has several vendor numbers (${found.join(", ")}); name one with vendor=<number>, and the connection keeps it`
            : "Apple's API does not return the vendor number. Sign in to App Store Connect under Credentials and it is read from the " +
              "Payments page, or add vendor=<number> (Payments and Financial Reports, top left) once; the connection keeps it",
          { kind: "credential", field: found.length ? "vendorNumber" : "webSession" });
        }
      }
      const api = appStoreConnect(credentials);
      const resource = input.app === "*" ? undefined : await appleApp(api, input.app!);
      const app = resource ? { id: resource.id, sku: text(resource.attributes.sku) } : undefined;
      const summary: SalesSummary = { periods: [], total: empty(), countries: new Map(), proceeds: new Map() };
      const reports: Array<string | undefined> = [];
      for (let start = 0; start < options.periods.length; start += PARALLEL) {
        reports.push(...await Promise.all(options.periods.slice(start, start + PARALLEL).map(period => api.report("/v1/salesReports", {
          "filter[frequency]": options.frequency, "filter[reportType]": "SALES", "filter[reportSubType]": "SUMMARY",
          "filter[vendorNumber]": vendor, "filter[reportDate]": period, "filter[version]": "1_0" }))));
      }
      /* Apple accepted the number, so later statements can leave it out. */
      if (vendor !== saved && saveCredentials) await saveCredentials({ vendorNumber: vendor }).catch(() => undefined);
      options.periods.forEach((period, index) => {
        const tsv = reports[index];
        if (tsv === undefined) return summary.periods.push({ period });
        const tally = empty();
        tallyReport(tsv, app, { tally, countries: summary.countries, proceeds: summary.proceeds });
        for (const key of Object.keys(tally) as Array<keyof Tally>) summary.total[key] += tally[key];
        return summary.periods.push({ period, tally });
      });
      const subject = resource ? `${text(resource.attributes.name) || input.app} (${input.app})` : "all apps";
      return { summary: `App Store sales for ${subject}, ${options.frequency === "DAILY" ? "per Pacific-time day" : "per month"}, newest first. ` +
        "Downloads are first-time installs; a period without a report has no sales or is not published yet:\n" +
        quoteRetrievedText(salesText(summary, options.frequency)),
        url: `https://appstoreconnect.apple.com/trends/insights` };
    },
  },
};
