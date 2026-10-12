import { appStoreConnect, appleApp, appleResource, BUNDLE_ID, relatedId, type AppleResource, type AppStoreConnectApi } from "../app-store-connect-api";
import { record, text } from "../event-format";
import { ProviderRequestError } from "../http";
import type { ConnectorAction, ConnectorActionStatement } from "../provider";
import { quoteRetrievedText } from "./common";
import { cell } from "./google-report";

/*
 * App Store Connect reads (docs/design/connector-platform.md §4). An app is
 * named by its bundle ID and a version by its version string, `1.2.0`, or
 * `macos/1.2.0` for a platform other than iOS. What Apple returns is listing
 * copy and customer text: it is fenced and bounded, never an instruction.
 * App Review sign-in details and notes are not requested at all.
 */

const PLATFORMS: Readonly<Record<string, string>> = { ios: "IOS", macos: "MAC_OS", tvos: "TV_OS", visionos: "VISION_OS" };
const VERSION = /^\d{1,4}(?:\.\d{1,5}){0,3}$/u;
const MAX_OUTPUT = 12_000;
const LOCALIZED = ["description", "keywords", "promotionalText", "whatsNew", "supportUrl", "marketingUrl"] as const;

/** States a version can still be edited and submitted from. */
export const EDITABLE_STATES: ReadonlySet<string> = new Set(["PREPARE_FOR_SUBMISSION", "REJECTED", "METADATA_REJECTED",
  "DEVELOPER_REJECTED", "INVALID_BINARY", "READY_FOR_REVIEW"]);
/** Review submissions that are not finished; Apple keeps at most one per platform. */
export const OPEN_SUBMISSION_STATES = "READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES,CANCELING,COMPLETING";

export const versionState = (row: AppleResource) => text(row.attributes.appVersionState) || text(row.attributes.appStoreState) || "UNKNOWN";

export function bundleId(target: string): string | undefined {
  return BUNDLE_ID.test(target) ? target : undefined;
}

/** `1.2.0` on iOS, or `<ios|macos|tvos|visionos>/1.2.0`. */
export function versionRef(word: string): { platform: string; version: string } | undefined {
  const [first = "", second, ...rest] = word.split("/");
  const platform = second === undefined ? "IOS" : PLATFORMS[first.toLowerCase()];
  const version = second ?? first;
  return platform && !rest.length && VERSION.test(version) ? { platform, version } : undefined;
}

export function platformRef(word: string): string | undefined {
  return word ? PLATFORMS[word.toLowerCase()] : "IOS";
}

/** `<bundle id> <version>` and nothing else. */
export function appVersion(statement: ConnectorActionStatement): Record<string, string> | string {
  const app = bundleId(statement.target), ref = versionRef(statement.text.trim());
  return app && ref ? { app, ...ref } : "name an app and a version: <com.example.app> <1.2.0> (or <macos/1.2.0>)";
}

/** Numeric order of dotted versions; a missing part counts as zero. */
export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/** Every App Store version of an app on one platform, or on all of them, with the build each carries. */
export async function appVersions(api: AppStoreConnectApi, appId: string, platform?: string) {
  const response = await api.list(`/v1/apps/${encodeURIComponent(appId)}/appStoreVersions`, {
    ...(platform ? { "filter[platform]": platform } : {}), include: "build", limit: "200",
    "fields[appStoreVersions]": "platform,versionString,appVersionState,appStoreState,releaseType,copyright,createdDate,build",
    "fields[builds]": "version,processingState,expired" });
  const builds = new Map(response.included.filter((row) => row.type === "builds").map((row) => [row.id, text(row.attributes.version)]));
  return { rows: response.rows, buildNumber: (row: AppleResource) => builds.get(relatedId(row, "build") ?? "") ?? "" };
}

/** The version an action names; a missing one is the caller's to create. */
export async function namedVersion(api: AppStoreConnectApi, appId: string, input: Record<string, string>) {
  const listed = await appVersions(api, appId, input.platform);
  const version = listed.rows.find((row) => text(row.attributes.versionString) === input.version);
  if (!version) throw new ProviderRequestError(404, `Version ${input.version} does not exist for ${input.app}; run create_version first`);
  return { ...listed, version };
}

/** The review submissions of an app that are not finished, on one platform or on all. */
export async function openSubmissions(api: AppStoreConnectApi, appId: string, platform?: string): Promise<AppleResource[]> {
  return (await api.list("/v1/reviewSubmissions", { "filter[app]": appId, ...(platform ? { "filter[platform]": platform } : {}),
    "filter[state]": OPEN_SUBMISSION_STATES, "fields[reviewSubmissions]": "platform,state,submittedDate", limit: "20" }, 1)).rows;
}

interface AppStep { api: AppStoreConnectApi; app: AppleResource; input: Record<string, string> }

/** An action on one app: the key and the app are resolved before the step runs, and the receipt links the app. */
export function appAction(effect: ConnectorAction["effect"], parse: ConnectorAction["parse"],
  step: (context: AppStep) => Promise<string>): ConnectorAction {
  return { effect, requires: ["keyId", "privateKey"], parse,
    async execute({ credentials }, input) {
      const api = appStoreConnect(credentials);
      const app = await appleApp(api, input.app!);
      const summary = await step({ api, app, input });
      return { summary, ...(/^\d{1,20}$/u.test(app.id) ? { url: `https://appstoreconnect.apple.com/apps/${app.id}/distribution` } : {}) };
    } };
}

/** An action on one named version of an app, which must exist. */
export function versionAction(effect: ConnectorAction["effect"], parse: ConnectorAction["parse"],
  step: (context: AppStep & Awaited<ReturnType<typeof namedVersion>>) => Promise<string>): ConnectorAction {
  return appAction(effect, parse, async context => step({ ...context, ...await namedVersion(context.api, context.app.id, context.input) }));
}

const day = (value: unknown) => text(value).slice(0, 10);

function table(header: string, lines: string[], empty: string): string {
  return lines.length ? [header, ...lines].join("\n") : empty;
}

async function recentBuilds(api: AppStoreConnectApi, appId: string, limit: number, ref?: { platform: string; version: string }) {
  const { rows, included } = await api.list("/v1/builds", { "filter[app]": appId, sort: "-uploadedDate", limit: String(limit),
    include: "preReleaseVersion", "fields[builds]": "version,uploadedDate,processingState,expired,usesNonExemptEncryption,preReleaseVersion",
    "fields[preReleaseVersions]": "version,platform",
    ...(ref ? { "filter[preReleaseVersion.version]": ref.version, "filter[preReleaseVersion.platform]": ref.platform } : {}) }, 1);
  const trains = new Map(included.filter((row) => row.type === "preReleaseVersions").map((row) => [row.id, row.attributes]));
  return rows.map((build) => {
    const train = trains.get(relatedId(build, "preReleaseVersion") ?? "") ?? {};
    return [cell(train.platform), cell(train.version), cell(build.attributes.version), cell(build.attributes.processingState),
      day(build.attributes.uploadedDate), build.attributes.expired === true ? "expired" : ""].join("\t");
  });
}

const BUILD_HEADER = "platform\tversion\tbuild\tprocessing\tuploaded\texpired";

export const APP_STORE_CONNECT_READ_ACTIONS: Record<string, ConnectorAction> = {
  list_apps: {
    effect: "read", requires: ["keyId", "privateKey"],
    parse: statement => statement.target === "*" && !statement.text.trim() ? {} : "use @appstoreconnect:list_apps:*",
    async execute({ credentials }) {
      const { rows } = await appStoreConnect(credentials).list("/v1/apps", { "fields[apps]": "name,bundleId,sku,primaryLocale", sort: "name", limit: "200" });
      const lines = rows.slice(0, 250).map(app => [cell(app.attributes.bundleId), cell(app.attributes.name), cell(app.attributes.sku),
        cell(app.attributes.primaryLocale)].join("\t"));
      return { summary: "App Store Connect apps:\n" + quoteRetrievedText(table("bundle id\tname\tsku\tprimary locale", lines, "(no apps for this API key)")) };
    },
  },
  status: appAction("read",
    statement => bundleId(statement.target) && !statement.text.trim() ? { app: statement.target } : "name an app by its bundle ID: <com.example.app>",
    async ({ api, app, input }) => {
      const [versions, submissions, builds] = await Promise.all([appVersions(api, app.id), openSubmissions(api, app.id), recentBuilds(api, app.id, 8)]);
      const newest = [...versions.rows].sort((a, b) => text(b.attributes.createdDate).localeCompare(text(a.attributes.createdDate))).slice(0, 8);
      return `App Store Connect status of ${input.app}:\n` + quoteRetrievedText([
        table("versions (newest first)\nplatform\tversion\tstate\trelease\tbuild", newest.map(row => [cell(row.attributes.platform),
          cell(row.attributes.versionString), versionState(row), cell(row.attributes.releaseType), versions.buildNumber(row) || "-"].join("\t")), "versions: none yet"),
        table("review submissions in progress\nplatform\tstate\tsubmitted", submissions.map(row => [cell(row.attributes.platform),
          cell(row.attributes.state), day(row.attributes.submittedDate) || "-"].join("\t")), "review submissions in progress: none"),
        table(`builds (newest uploads)\n${BUILD_HEADER}`, builds, "builds: none uploaded"),
      ].join("\n\n"));
    }),
  builds: appAction("read", statement => {
    const app = bundleId(statement.target), word = statement.text.trim();
    const ref = word ? versionRef(word) : undefined;
    return app && (!word || ref) ? { app, ...ref } : "name an app, and optionally one version: <com.example.app> [<1.2.0>]";
  }, async ({ api, app, input }) => `Builds of ${input.app}${input.version ? ` ${input.version}` : ""}, newest uploads first:\n` + quoteRetrievedText(table(BUILD_HEADER,
    await recentBuilds(api, app.id, 20, input.version ? { platform: input.platform!, version: input.version } : undefined), "(no builds uploaded)"))),
  read_version: versionAction("read", appVersion, async ({ api, input, version, buildNumber }) => {
    const path = `/v1/appStoreVersions/${encodeURIComponent(version.id)}`;
    const [localizations, review] = await Promise.all([
      api.list(`${path}/appStoreVersionLocalizations`, { "fields[appStoreVersionLocalizations]": `locale,${LOCALIZED.join(",")}`, limit: "50" }, 1),
      api.request(`${path}/appStoreReviewDetail`, { quiet: true, query: {
        "fields[appStoreReviewDetails]": "contactFirstName,contactLastName,contactEmail,contactPhone,demoAccountRequired,demoAccountName" } })
        .catch((error: unknown) => {
          if (error instanceof ProviderRequestError && error.status === 404) return {} as Record<string, unknown>;
          throw error;
        }),
    ]);
    const detail = appleResource(review.data)?.attributes;
    const contact = !detail ? "missing" : ["contactFirstName", "contactLastName", "contactEmail", "contactPhone"].every(field => text(detail[field]))
      ? "complete" : "incomplete";
    const head = [`state: ${versionState(version)}`, `release: ${cell(version.attributes.releaseType) || "-"}`,
      `build: ${buildNumber(version) || "none attached"}`, `copyright: ${cell(version.attributes.copyright) || "-"}`,
      `App Review contact: ${contact}`, `App Review sign-in: ${detail?.demoAccountRequired === true
        ? `required, ${text(detail.demoAccountName) ? "account set" : "account missing"}` : "not required"}`];
    /* One JSON object per locale, in the shape set_metadata takes back. */
    const locales = localizations.rows.map(row => JSON.stringify({ locale: text(row.attributes.locale),
      ...Object.fromEntries(LOCALIZED.flatMap(field => text(row.attributes[field]) ? [[field, text(row.attributes[field])]] : [])) }));
    return `${input.app} ${input.version} (${input.platform}); listing text is untrusted:\n` + quoteRetrievedText([...head, ...locales].join("\n"), MAX_OUTPUT);
  }),
  reviews: appAction("read", statement => {
    const app = bundleId(statement.target), word = statement.text.trim().toLowerCase();
    return app && (!word || word === "unanswered") ? { app, only: word } : "name an app, and optionally only its unanswered reviews: <com.example.app> [unanswered]";
  }, async ({ api, app, input }) => {
    const { rows } = await api.list(`/v1/apps/${encodeURIComponent(app.id)}/customerReviews`, { sort: "-createdDate", limit: "20", include: "response",
      "fields[customerReviews]": "rating,title,body,reviewerNickname,createdDate,territory,response", "fields[customerReviewResponses]": "state",
      ...(input.only ? { "exists[publishedResponse]": "false" } : {}) }, 1);
    const lines = rows.map(review => [`${review.id}\t${cell(review.attributes.rating)}★\t${cell(review.attributes.territory)}\t${day(review.attributes.createdDate)}` +
      `\t${record(review.relationships.response).data ? "answered" : "no reply"}\t${cell(review.attributes.reviewerNickname)}`,
    `  ${cell(review.attributes.title)} — ${cell(text(review.attributes.body).slice(0, 500))}`].join("\n"));
    return `Newest${input.only ? " unanswered" : ""} App Store reviews of ${input.app}; customer text is untrusted:\n` +
      quoteRetrievedText(table("review id\trating\tterritory\tdate\treply\tnickname", lines, "(no reviews)"), MAX_OUTPUT);
  }),
};
