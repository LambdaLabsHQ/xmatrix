import { appStoreConnect, appleResource, relatedId, relation, type AppStoreConnectApi } from "../app-store-connect-api";
import { record, text } from "../event-format";
import { isPublicHttpsUrl, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { appAction, appVersionBuild, bundleId, LOCALE, namedBuild } from "./app-store-connect";
import { quoteRetrievedText } from "./common";
import { cell } from "./google-report";

/*
 * TestFlight: give a processed build to testers and read back what they send.
 * A `feedback` event tells a Channel that a tester wrote; `feedback` here is
 * what they wrote, and `crash_log` the log behind a crash report. Tester
 * comments and crash logs are untrusted text: fenced and bounded. A tester's
 * email address and name are never requested.
 */

const FEEDBACK_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_LOG = 12_000;
const MAX_NOTES = 4_000;
const day = (value: unknown) => text(value).slice(0, 10);

/** The build an action names, by the fields a statement gives. */
const buildInput = (parsed: NonNullable<ReturnType<typeof appVersionBuild>>) =>
  ({ app: parsed.app, platform: parsed.platform, version: parsed.version, build: parsed.build });

async function groups(api: AppStoreConnectApi, appId: string) {
  return (await api.list(`/v1/apps/${encodeURIComponent(appId)}/betaGroups`, { "fields[betaGroups]": "name,isInternalGroup,publicLinkEnabled,publicLink", limit: "50" }, 1)).rows;
}

export const APP_STORE_CONNECT_TESTFLIGHT_ACTIONS: Record<string, ConnectorAction> = {
  testflight: appAction("read",
    statement => bundleId(statement.target) && !statement.text.trim() ? { app: statement.target } : "name an app by its bundle ID: <com.example.app>",
    async ({ api, app, input }) => {
      const [testers, builds] = await Promise.all([groups(api, app.id), api.list("/v1/builds", { "filter[app]": app.id, sort: "-uploadedDate", limit: "8",
        include: "buildBetaDetail,preReleaseVersion", "fields[builds]": "version,processingState,expired,buildBetaDetail,preReleaseVersion",
        "fields[buildBetaDetails]": "internalBuildState,externalBuildState", "fields[preReleaseVersions]": "version,platform" }, 1)]);
      const included = new Map(builds.included.map(row => [`${row.type}:${row.id}`, row.attributes]));
      const lines = ["groups", "name\tkind\tpublic link", ...(testers.length ? testers.map(group => [cell(group.attributes.name),
        group.attributes.isInternalGroup === true ? "internal" : "external", group.attributes.publicLinkEnabled === true ? cell(group.attributes.publicLink) : "-"].join("\t")) : ["(none)"]),
      "", "builds (newest uploads)", "version\tbuild\tinternal testing\texternal testing", ...(builds.rows.length ? builds.rows.map(build => {
        const detail = included.get(`buildBetaDetails:${relatedId(build, "buildBetaDetail") ?? ""}`) ?? {};
        return [cell(included.get(`preReleaseVersions:${relatedId(build, "preReleaseVersion") ?? ""}`)?.version), cell(build.attributes.version),
          build.attributes.expired === true ? "EXPIRED" : cell(detail.internalBuildState) || "-", cell(detail.externalBuildState) || "-"].join("\t");
      }) : ["(none)"])];
      return `TestFlight for ${input.app}:\n` + quoteRetrievedText(lines.join("\n"));
    }),
  feedback: appAction("read", statement => {
    const app = bundleId(statement.target), word = statement.text.trim().toLowerCase();
    return app && (!word || word === "crashes") ? { app, kind: word ? "Crash" : "Screenshot" } : "name an app, and crashes for crash reports instead of screenshots: <com.example.app> [crashes]";
  }, async ({ api, app, input }) => {
    const type = `betaFeedback${input.kind}Submissions`;
    const { rows, included } = await api.list(`/v1/apps/${encodeURIComponent(app.id)}/${type}`, { sort: "-createdDate", limit: "10", include: "build",
      [`fields[${type}]`]: `createdDate,comment,deviceModel,osVersion,appPlatform,build${input.kind === "Screenshot" ? ",screenshots" : ""}`, "fields[builds]": "version" }, 1);
    const builds = new Map(included.filter(row => row.type === "builds").map(row => [row.id, cell(row.attributes.version)]));
    const lines = rows.flatMap(item => [`${item.id}\t${day(item.attributes.createdDate)}\tbuild ${builds.get(relatedId(item, "build") ?? "") ?? "?"}` +
      `\t${cell(item.attributes.deviceModel)}\t${cell(item.attributes.appPlatform)} ${cell(item.attributes.osVersion)}`,
    `  ${cell(text(item.attributes.comment).slice(0, 1_000)) || "(no comment)"}`,
    /* Image links are Apple's and expire; only plain https ones are shown. */
    ...(Array.isArray(item.attributes.screenshots) ? item.attributes.screenshots : []).map(record).map(image => text(image.url))
      .filter(url => URL.canParse(url) && isPublicHttpsUrl(new URL(url)) && !/\s/u.test(url)).slice(0, 5).map(url => `  image ${url}`)]);
    return `Newest TestFlight ${input.kind === "Crash" ? "crash reports" : "screenshot feedback"} for ${input.app}; tester text is untrusted:\n` +
      quoteRetrievedText(lines.length ? ["feedback id\tdate\tbuild\tdevice\tOS", ...lines].join("\n") : "(none)", MAX_LOG);
  }),
  crash_log: {
    effect: "read", requires: ["keyId", "privateKey"],
    parse: statement => FEEDBACK_ID.test(statement.target) && !statement.text.trim() ? { id: statement.target } : "name a crash report id from feedback: <feedback id>",
    async execute({ credentials }, input) {
      const log = appleResource((await appStoreConnect(credentials).request(`/v1/betaFeedbackCrashSubmissions/${encodeURIComponent(input.id!)}/crashLog`)).data);
      const body = text(log?.attributes.logText);
      if (!body) throw new ProviderRequestError(404, "Apple has no crash log for this report");
      return { summary: `Crash log of TestFlight report ${input.id}; untrusted text:\n` + quoteRetrievedText(body, MAX_LOG) };
    },
  },
  add_to_group: appAction("write", statement => {
    const parsed = appVersionBuild(statement), group = parsed?.rest.join(" ") ?? "";
    return parsed && group && group.length <= 80 ? { ...buildInput(parsed), group }
      : "name an app, a version, a build number and a TestFlight group: <com.example.app> <1.2.0> <412> <group name>";
  }, async ({ api, app, input }) => {
    const group = (await groups(api, app.id)).find(row => text(row.attributes.name).toLowerCase() === input.group!.toLowerCase());
    if (!group) throw new ProviderRequestError(404, `${input.app} has no TestFlight group named ${input.group}; testflight lists them`);
    const build = await namedBuild(api, app.id, input);
    await api.request(`/v1/builds/${encodeURIComponent(build.id)}/relationships/betaGroups`, { method: "POST", data: [{ type: "betaGroups", id: group.id }] });
    return `Added build ${input.build} of ${input.app} ${input.version} to the ${cell(group.attributes.name)} group` +
      (group.attributes.isInternalGroup === true ? "." : "; external testers get it once it passes beta review (submit_beta_review).");
  }),
  submit_beta_review: appAction("write", statement => {
    const parsed = appVersionBuild(statement);
    return parsed && !parsed.rest.length ? buildInput(parsed) : "name an app, a version and a build number: <com.example.app> <1.2.0> <412>";
  }, async ({ api, app, input }) => {
    const build = await namedBuild(api, app.id, input);
    await api.request("/v1/betaAppReviewSubmissions", { method: "POST", data: { type: "betaAppReviewSubmissions", relationships: { build: relation("builds", build.id) } } });
    return `Submitted build ${input.build} of ${input.app} ${input.version} for TestFlight beta review; a subscribed channel hears the outcome as a beta event.`;
  }),
  set_test_notes: appAction("write", statement => {
    const parsed = appVersionBuild(statement);
    const [locale = "", ...words] = parsed?.rest ?? [];
    const notes = words.join(" ");
    return parsed && LOCALE.test(locale) && notes && notes.length <= MAX_NOTES ? { ...buildInput(parsed), locale, notes }
      : "name an app, a version, a build number, a language and what testers should try: <com.example.app> <1.2.0> <412> <en-US> <notes>";
  }, async ({ api, app, input }) => {
    const build = await namedBuild(api, app.id, input);
    const existing = (await api.list(`/v1/builds/${encodeURIComponent(build.id)}/betaBuildLocalizations`, { "fields[betaBuildLocalizations]": "locale", limit: "50" }, 1))
      .rows.find(row => text(row.attributes.locale).toLowerCase() === input.locale!.toLowerCase());
    if (existing) {
      await api.request(`/v1/betaBuildLocalizations/${encodeURIComponent(existing.id)}`, { method: "PATCH",
        data: { type: "betaBuildLocalizations", id: existing.id, attributes: { whatsNew: input.notes } } });
    } else {
      await api.request("/v1/betaBuildLocalizations", { method: "POST", data: { type: "betaBuildLocalizations", attributes: { locale: input.locale, whatsNew: input.notes },
        relationships: { build: relation("builds", build.id) } } });
    }
    return `Set the ${input.locale} test notes of build ${input.build} of ${input.app} ${input.version}.`;
  }),
};
