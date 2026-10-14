import { appStoreConnect, appleApp, appleResource, BUNDLE_ID, relatedId, type AppleResource, type AppStoreConnectApi } from "./app-store-connect-api";
import { webSession } from "./app-store-connect-web";
import { jsonFields, LOCALE, textFieldProblem } from "./actions/app-store-connect";
import { cell } from "./actions/google-report";
import { record, text } from "./event-format";
import { ProviderRequestError } from "./http";
import type { ConnectorAction } from "./provider";

/*
 * What only the App Store Connect website does, through the same web session
 * as App Review's messages (app-store-connect-web.ts): creating an app record
 * and answering App Privacy. Apple's public API has neither; the requests are
 * the ones fastlane's `produce` and `upload_app_privacy_details_to_app_store`
 * send to the website's `iris` endpoints. The API key still finds the app and
 * checks the bundle ID, so the session is only used for what needs it.
 *
 * Each write is sent once. Answering App Privacy replaces every answer and
 * then publishes them, as the website's Publish button does; a run cut short
 * says how far it got, and running it again starts over.
 */

const PLATFORMS: Readonly<Record<string, string>> = { ios: "IOS", macos: "MAC_OS", tvos: "TV_OS", visionos: "VISION_OS" };
const VERSION = /^\d{1,4}(?:\.\d{1,5}){0,3}$/u;
const SKU = /^[A-Za-z0-9._-]{1,100}$/u;
const ID = /^[A-Z][A-Z0-9_]{1,60}$/u;
const LINKED = "DATA_LINKED_TO_YOU", NOT_LINKED = "DATA_NOT_LINKED_TO_YOU", TRACKING = "DATA_USED_TO_TRACK_YOU", NOT_COLLECTED = "DATA_NOT_COLLECTED";
const MAX_TEXT = 6_000;
const MAX_TYPES = 40;
const MAX_ANSWERS = 200;

const privacyUsage = 'name an app and what it collects: <com.example.app> {"data":[{"category":"EMAIL_ADDRESS","purposes":["APP_FUNCTIONALITY"],"linked":true,"tracking":false}]} — "data":[] when it collects nothing';

interface DataType { category: string; purposes: string[]; linked: boolean; tracking: boolean }

/** The one registered bundle ID with this identifier, or why there is none. */
async function registeredBundleId(api: AppStoreConnectApi, identifier: string): Promise<AppleResource> {
  const { rows } = await api.list("/v1/bundleIds", { "filter[identifier]": identifier, "fields[bundleIds]": "identifier,name,platform", limit: "20" }, 1);
  const bundle = rows.find(row => text(row.attributes.identifier).toLowerCase() === identifier.toLowerCase());
  if (!bundle) throw new ProviderRequestError(404, `${identifier} is not a registered bundle ID; run register_bundle_id first`);
  return bundle;
}

/** Apple's current ids for a privacy list (categories or purposes), which the website adds to over time. */
async function knownIds(session: ReturnType<typeof webSession>, path: string): Promise<Set<string>> {
  const listed = await session.read(path, { limit: "200" });
  return new Set((Array.isArray(listed.data) ? listed.data : []).map(row => text(record(row).id)).filter(Boolean));
}

function dataTypes(value: unknown): DataType[] | string {
  if (!Array.isArray(value) || value.length > MAX_TYPES) return privacyUsage;
  const seen = new Set<string>();
  const types: DataType[] = [];
  for (const entry of value.map(record)) {
    const { category, purposes, linked, tracking, ...rest } = entry;
    if (Object.keys(rest).length) return `each data type has only category, purposes, linked and tracking; not ${Object.keys(rest).join(", ")}`;
    if (typeof category !== "string" || !ID.test(category)) return "a category is Apple's id, such as EMAIL_ADDRESS or CRASH_DATA";
    if (seen.has(category)) return `${category} is listed twice`;
    seen.add(category);
    if (!Array.isArray(purposes) || !purposes.length || purposes.some(purpose => typeof purpose !== "string" || !ID.test(purpose)) || new Set(purposes).size !== purposes.length) {
      return `${category} needs its purposes, such as ["APP_FUNCTIONALITY","ANALYTICS"]`;
    }
    if (typeof linked !== "boolean" || typeof tracking !== "boolean") return `${category} says explicitly whether it is linked to the user and used to track them: "linked":true,"tracking":false`;
    types.push({ category, purposes: purposes as string[], linked, tracking });
  }
  return types;
}

const usage = (appId: string, category: string | undefined, purpose: string | undefined, protection: string) => ({ data: { type: "appDataUsages",
  relationships: { app: { data: { type: "apps", id: appId } },
    ...(category ? { category: { data: { type: "appDataUsageCategories", id: category } } } : {}),
    ...(purpose ? { purpose: { data: { type: "appDataUsagePurposes", id: purpose } } } : {}),
    dataProtection: { data: { type: "appDataUsageDataProtections", id: protection } } } } });

export const APP_STORE_CONNECT_WEB_RECORD_ACTIONS: Record<string, ConnectorAction> = {
  create_app: {
    effect: "write", requires: ["webSession", "keyId", "privateKey"],
    parse(statement) {
      const usageText = 'name the bundle ID and the app: <com.example.app> {"name":"Example","sku":"EXAMPLE","locale":"en-US","version":"1.0","platform":"ios"}';
      const json = statement.text.trim();
      const fields = BUNDLE_ID.test(statement.target) && json && json.length <= MAX_TEXT ? jsonFields(json) : undefined;
      if (!fields) return usageText;
      const { name, sku, locale, version = "1.0", platform = "ios", company, ...rest } = fields;
      if (Object.keys(rest).length) return `create_app takes name, sku, locale, version, platform and company; not ${Object.keys(rest).join(", ")}`;
      const problem = textFieldProblem("name", name, 30) ?? (company === undefined ? undefined : textFieldProblem("company", company, 100));
      if (problem) return problem;
      if (typeof sku !== "string" || !SKU.test(sku)) return "sku is your own id for the app: letters, digits, dot, dash or underscore, at most 100";
      if (typeof locale !== "string" || !LOCALE.test(locale)) return 'locale is the primary language: "locale":"en-US"';
      if (typeof version !== "string" || !VERSION.test(version)) return 'version is the first version to prepare: "version":"1.0"';
      const platformId = typeof platform === "string" ? PLATFORMS[platform.toLowerCase()] : undefined;
      if (!platformId) return `platform is ${Object.keys(PLATFORMS).join(", ")}`;
      return { app: statement.target, name: name as string, sku, locale, version, platform: platformId, company: typeof company === "string" ? company : "" };
    },
    async execute(context, input) {
      const api = appStoreConnect(context.credentials);
      const existing = (await api.list("/v1/apps", { "filter[bundleId]": input.app!, "fields[apps]": "bundleId,name", limit: "20" }, 1)).rows
        .find(row => text(row.attributes.bundleId).toLowerCase() === input.app!.toLowerCase());
      if (existing) throw new ProviderRequestError(409, `${input.app} already has an app record, ${cell(existing.attributes.name)} (${existing.id})`);
      const bundle = await registeredBundleId(api, input.app!);
      const session = webSession(context);
      try {
        const versionId = `\${store-version-${input.platform}}`, versionLocalization = `\${new-${input.platform}VersionLocalization-id}`;
        const created = await session.send("POST", "/iris/v1/apps", {
          data: { type: "apps",
            attributes: { sku: input.sku, primaryLocale: input.locale, bundleId: text(bundle.attributes.identifier) || input.app, ...(input.company ? { companyName: input.company } : {}) },
            relationships: { appStoreVersions: { data: [{ type: "appStoreVersions", id: versionId }] }, appInfos: { data: [{ type: "appInfos", id: "${new-appInfo-id}" }] } } },
          included: [
            { type: "appInfos", id: "${new-appInfo-id}", relationships: { appInfoLocalizations: { data: [{ type: "appInfoLocalizations", id: "${new-appInfoLocalization-id}" }] } } },
            { type: "appInfoLocalizations", id: "${new-appInfoLocalization-id}", attributes: { locale: input.locale, name: input.name } },
            { type: "appStoreVersions", id: versionId, attributes: { platform: input.platform, versionString: input.version },
              relationships: { appStoreVersionLocalizations: { data: [{ type: "appStoreVersionLocalizations", id: versionLocalization }] } } },
            { type: "appStoreVersionLocalizations", id: versionLocalization, attributes: { locale: input.locale } },
          ],
        });
        const id = text(record(created.data).id);
        return { summary: `Created the app record ${input.name} for ${input.app}${id ? ` (Apple id ${id})` : ""}, with version ${input.version} to prepare. ` +
          "read_app lists what it needs before its first submission; privacy answers App Privacy." };
      } finally { await session.settle(); }
    },
  },
  privacy: {
    effect: "read", requires: ["webSession", "keyId", "privateKey"],
    parse: statement => BUNDLE_ID.test(statement.target) && !statement.text.trim() ? { app: statement.target } : "name an app by its bundle ID: <com.example.app>",
    async execute(context, input) {
      const app = await appleApp(appStoreConnect(context.credentials), input.app!);
      const session = webSession(context);
      try {
        const [usages, state] = await Promise.all([
          session.read(`/iris/v1/apps/${encodeURIComponent(app.id)}/dataUsages`, { include: "category,purpose,dataProtection", limit: "500" }),
          session.read(`/iris/v1/apps/${encodeURIComponent(app.id)}/dataUsagePublishState`),
        ]);
        const rows = (Array.isArray(usages.data) ? usages.data : []).flatMap(row => appleResource(row) ?? []);
        const published = record(record(state.data).attributes).published === true;
        if (!rows.length) return { summary: `${input.app} has not answered App Privacy yet; set_privacy answers it.` };
        const byCategory = new Map<string, { purposes: Set<string>; protections: Set<string> }>();
        for (const row of rows) {
          const protection = relatedId(row, "dataProtection") ?? "";
          if (protection === NOT_COLLECTED) return { summary: `${input.app}: App Privacy says no data is collected (${published ? "published" : "not published yet"}).` };
          const category = relatedId(row, "category") ?? "?";
          const entry = byCategory.get(category) ?? { purposes: new Set<string>(), protections: new Set<string>() };
          const purpose = relatedId(row, "purpose");
          if (purpose) entry.purposes.add(purpose);
          if (protection) entry.protections.add(protection);
          byCategory.set(category, entry);
        }
        const lines = [...byCategory].map(([category, entry]) => `- ${category}: ${[...entry.purposes].join(", ") || "no purpose"}; ` +
          `${entry.protections.has(LINKED) ? "linked to the user" : entry.protections.has(NOT_LINKED) ? "not linked" : "linkage not answered"}` +
          `${entry.protections.has(TRACKING) ? "; used to track" : ""}`);
        return { summary: `${input.app} App Privacy (${published ? "published" : "not published yet"}), ${byCategory.size} data type(s):\n${lines.join("\n")}` };
      } finally { await session.settle(); }
    },
  },
  set_privacy: {
    effect: "write", requires: ["webSession", "keyId", "privateKey"],
    parse(statement) {
      const json = statement.text.trim();
      const fields = BUNDLE_ID.test(statement.target) && json && json.length <= MAX_TEXT ? jsonFields(json) : undefined;
      if (!fields) return privacyUsage;
      const { data, publish = true, ...rest } = fields;
      if (Object.keys(rest).length || typeof publish !== "boolean") return privacyUsage;
      const types = dataTypes(data);
      if (typeof types === "string") return types;
      const answers = types.reduce((sum, type) => sum + type.purposes.length * (type.tracking ? 2 : 1), 0);
      if (answers > MAX_ANSWERS) return `that is ${answers} answers; at most ${MAX_ANSWERS} are sent in one run`;
      return { app: statement.target, types: JSON.stringify(types), publish: publish ? "yes" : "no" };
    },
    async execute(context, input) {
      const app = await appleApp(appStoreConnect(context.credentials), input.app!);
      const types = JSON.parse(input.types!) as DataType[];
      const session = webSession(context);
      let removed = 0, added = 0;
      try {
        if (types.length) {
          const [categories, purposes] = await Promise.all([knownIds(session, "/iris/v1/appDataUsageCategories"), knownIds(session, "/iris/v1/appDataUsagePurposes")]);
          const unknownCategory = categories.size ? types.find(type => !categories.has(type.category)) : undefined;
          if (unknownCategory) throw new ProviderRequestError(400, `${unknownCategory.category} is not one of Apple's data types: ${[...categories].sort().join(", ")}`);
          const unknownPurpose = purposes.size ? types.flatMap(type => type.purposes).find(purpose => !purposes.has(purpose)) : undefined;
          if (unknownPurpose) throw new ProviderRequestError(400, `${unknownPurpose} is not one of Apple's purposes: ${[...purposes].sort().join(", ")}`);
        }
        const existing = await session.read(`/iris/v1/apps/${encodeURIComponent(app.id)}/dataUsages`, { limit: "500" });
        for (const row of Array.isArray(existing.data) ? existing.data : []) {
          const id = text(record(row).id);
          if (!id) continue;
          await session.send("DELETE", `/iris/v1/appDataUsages/${encodeURIComponent(id)}`);
          removed += 1;
        }
        const answers = types.length ? types.flatMap(type => type.purposes.flatMap(purpose =>
          [type.linked ? LINKED : NOT_LINKED, ...(type.tracking ? [TRACKING] : [])].map(protection => usage(app.id, type.category, purpose, protection))))
          : [usage(app.id, undefined, undefined, NOT_COLLECTED)];
        for (const answer of answers) {
          await session.send("POST", "/iris/v1/appDataUsages", answer);
          added += 1;
        }
        let published = "left unpublished, as asked";
        if (input.publish === "yes") {
          const state = record((await session.read(`/iris/v1/apps/${encodeURIComponent(app.id)}/dataUsagePublishState`)).data);
          const stateId = text(state.id);
          if (!stateId) throw new ProviderRequestError(502, "App Store Connect did not say where App Privacy is published");
          await session.send("PATCH", `/iris/v1/appDataUsagesPublishState/${encodeURIComponent(stateId)}`,
            { data: { type: "appDataUsagesPublishState", id: stateId, attributes: { published: true } } });
          published = "published";
        }
        return { summary: `${input.app} App Privacy now says ${types.length ? `${types.length} data type(s) are collected (${types.map(type => type.category).join(", ")})` : "no data is collected"}; ` +
          `${added} answer(s) sent, ${removed} earlier one(s) replaced, ${published}.` };
      } catch (error) {
        if (!(error instanceof ProviderRequestError) || (!removed && !added)) throw error;
        throw new ProviderRequestError(error.status, `${error.message}. App Privacy is part way: ${removed} earlier answer(s) removed and ${added} sent; run set_privacy again to answer it whole`);
      } finally { await session.settle(); }
    },
  },
};
