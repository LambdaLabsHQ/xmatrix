import type { ConnectorAction } from "../provider";
import { record } from "../command-support";
import { providerJson, ProviderRequestError } from "../http";
import { quoteRetrievedText } from "./common";
import { pageUrl } from "./google-search-console-site";
import { cell, keyedOptions, mappedChoices } from "./google-report";

/*
 * PageSpeed Insights v5 (a Lighthouse run Google makes against a public page)
 * and the Chrome UX Report API (real-user Core Web Vitals), read-only. The
 * credential is a Google Cloud API key with both APIs enabled; it travels in
 * the x-goog-api-key header, never in a URL.
 */

const PSI = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const CRUX = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];
/* Only what is reported is asked for, so a full Lighthouse report never crosses the response bound. */
const PSI_FIELDS = "id,lighthouseResult(finalUrl,fetchTime,runWarnings,categories/*/score,audits/*(title,score,scoreDisplayMode,displayValue))," +
  "loadingExperience(overall_category,metrics)";
const LAB = ["largest-contentful-paint", "cumulative-layout-shift", "total-blocking-time", "first-contentful-paint", "speed-index"];
/* Core Web Vitals first; time to first byte has carried an `experimental_` prefix in the Chrome UX Report. */
const FIELD = ["largest_contentful_paint", "interaction_to_next_paint", "cumulative_layout_shift", "first_contentful_paint",
  "time_to_first_byte", "experimental_time_to_first_byte"];
const FORMS: Record<string, string | undefined> = { phone: "PHONE", desktop: "DESKTOP", all: undefined };
const MAX_FAILING = 15;
/* A Lighthouse run commonly takes 10–30 seconds. */
const AUDIT_TIMEOUT_MS = 60_000;

function apiKey(credentials: Readonly<Record<string, string>>): Record<string, string> {
  const key = credentials.apiKey?.trim();
  if (!key || key.length > 200 || !/^[A-Za-z0-9_-]+$/u.test(key)) {
    throw new ProviderRequestError(401, "Save a Google API key with the PageSpeed Insights and Chrome UX Report APIs enabled");
  }
  return { "x-goog-api-key": key };
}

function score(value: unknown): string {
  return typeof value === "number" ? String(Math.round(value * 100)) : "-";
}

/** `<url> [strategy=mobile|desktop]` */
export function auditInput(statement: { target: string; text: string }): Record<string, string> | string {
  const usage = "name a public page: <https://example.com/page> [strategy=mobile|desktop]";
  const url = pageUrl(statement.target);
  const options = keyedOptions(statement.text, ["strategy"], usage);
  if (!url || typeof options === "string") return usage;
  const strategy = options.get("strategy") ?? "mobile";
  return ["mobile", "desktop"].includes(strategy) ? { url: url.href, strategy } : usage;
}

/** `<url or origin> [form=phone|desktop|all] [scope=page|origin]`; an origin-only address reads the origin. */
export function fieldInput(statement: { target: string; text: string }): Record<string, string> | string {
  const usage = "name a public page or origin: <https://example.com/page> [form=phone|desktop|all] [scope=page|origin]";
  const url = pageUrl(statement.target);
  const options = keyedOptions(statement.text, ["form", "scope"], usage);
  if (!url || typeof options === "string") return usage;
  const form = options.get("form") ?? "all";
  const scope = options.get("scope") ?? (url.pathname === "/" && !url.search ? "origin" : "page");
  if (!mappedChoices([form], FORMS) || !["page", "origin"].includes(scope)) return usage;
  return { [scope === "origin" ? "origin" : "url"]: scope === "origin" ? url.origin : url.href, form };
}

function fieldLines(metrics: Record<string, unknown>, names: string[], p75: (metric: Record<string, unknown>) => unknown,
  shares: (metric: Record<string, unknown>) => unknown[]): string[] {
  return names.filter(name => metrics[name] !== undefined).map(name => {
    const metric = record(metrics[name]);
    const buckets = shares(metric).map(value => `${Math.round(Number(value) * 100)}%`);
    return [name, cell(p75(metric)), ...buckets].join("\t");
  });
}

export const PAGESPEED_ACTIONS: Record<string, ConnectorAction> = {
  audit: {
    effect: "read", requires: ["apiKey"],
    parse: auditInput,
    async execute({ credentials }, input) {
      const url = new URL(PSI);
      url.searchParams.set("url", input.url!);
      url.searchParams.set("strategy", input.strategy!);
      for (const category of CATEGORIES) url.searchParams.append("category", category.toUpperCase().replace("-", "_"));
      url.searchParams.set("fields", PSI_FIELDS);
      const result = await providerJson(url, { headers: apiKey(credentials), timeoutMs: AUDIT_TIMEOUT_MS });
      const lighthouse = record(result.lighthouseResult);
      const categories = record(lighthouse.categories);
      const audits = record(lighthouse.audits);
      if (!Object.keys(categories).length || !Object.keys(audits).length) {
        throw new ProviderRequestError(502, "Google did not return a Lighthouse result");
      }
      const lines = [`final url: ${cell(lighthouse.finalUrl)}`, `fetched: ${cell(lighthouse.fetchTime)}`,
        `scores: ${CATEGORIES.map(category => `${category} ${score(record(categories[category]).score)}`).join(", ")}`,
        "lab metrics:", ...LAB.filter(id => audits[id] !== undefined).map(id => `  ${id}\t${cell(record(audits[id]).displayValue)}`)];
      const failing = Object.entries(audits).map(([id, value]) => ({ id, audit: record(value) }))
        .filter(({ id, audit }) => typeof audit.score === "number" && audit.score < 0.9 &&
          ["binary", "numeric", "metricSavings"].includes(String(audit.scoreDisplayMode)) && !LAB.includes(id))
        .sort((a, b) => Number(a.audit.score) - Number(b.audit.score));
      if (failing.length) {
        lines.push(`failing audits (${failing.length}${failing.length > MAX_FAILING ? `; worst ${MAX_FAILING} shown` : ""}):`,
          ...failing.slice(0, MAX_FAILING).map(({ id, audit }) =>
            `  ${cell(id)}\t${score(audit.score)}\t${cell(audit.title)}${audit.displayValue ? ` (${cell(audit.displayValue)})` : ""}`));
      }
      const experience = record(result.loadingExperience);
      if (experience.overall_category) {
        lines.push(`field data (28 days, Chrome users): ${cell(experience.overall_category)}`,
          ...fieldLines(record(experience.metrics), Object.keys(record(experience.metrics)).slice(0, 10), metric => metric.percentile,
            metric => (Array.isArray(metric.distributions) ? metric.distributions : []).map(bucket => record(bucket).proportion)));
      }
      const warnings = Array.isArray(lighthouse.runWarnings) ? lighthouse.runWarnings.slice(0, 3).map(cell) : [];
      if (warnings.length) lines.push(...warnings.map(warning => `warning: ${warning}`));
      return { summary: `PageSpeed Insights (${input.strategy}) for ${input.url}:\n` + quoteRetrievedText(lines.join("\n")) };
    },
  },
  field: {
    effect: "read", requires: ["apiKey"],
    parse: fieldInput,
    async execute({ credentials }, input) {
      const subject = input.origin ? { origin: input.origin } : { url: input.url! };
      const form = FORMS[input.form!];
      let result: Record<string, unknown>;
      try {
        result = await providerJson(CRUX, { method: "POST", headers: apiKey(credentials),
          json: { ...subject, ...(form ? { formFactor: form } : {}) } });
      } catch (error) {
        if (error instanceof ProviderRequestError && error.status === 404) {
          return { summary: `The Chrome UX Report has no data for ${input.origin ?? input.url} (${input.form}): too few Chrome visits. ` +
            "Try the origin (scope=origin) or form=all." };
        }
        throw error;
      }
      const report = record(result.record);
      const metrics = record(report.metrics);
      if (!Object.keys(metrics).length) throw new ProviderRequestError(502, "Google did not return Chrome UX Report metrics");
      const period = record(report.collectionPeriod);
      const day = (value: unknown) => ["year", "month", "day"].map(part => String(record(value)[part] ?? "?").padStart(2, "0")).join("-");
      const lines = ["metric\tp75\tgood\tneeds improvement\tpoor",
        ...fieldLines(metrics, FIELD, metric => record(metric.percentiles).p75,
          metric => (Array.isArray(metric.histogram) ? metric.histogram : []).map(bucket => record(bucket).density ?? 0))];
      return { summary: `Chrome UX Report for ${input.origin ?? input.url} (${input.form}; ${day(period.firstDate)} to ${day(period.lastDate)}; ` +
        "milliseconds except CLS):\n" + quoteRetrievedText(lines.join("\n")) };
    },
  },
};

/** Confirm the key with a real Chrome UX Report read for a well-known origin; a key without the API fails here. */
export async function verifyPageSpeed(credentials: Readonly<Record<string, string>>): Promise<void> {
  const result = await providerJson(CRUX, { method: "POST", headers: apiKey(credentials),
    json: { origin: "https://developer.chrome.com", metrics: ["largest_contentful_paint"] } });
  if (!Object.keys(record(record(result.record).metrics)).length) {
    throw new ProviderRequestError(502, "Google did not confirm Chrome UX Report access");
  }
}
