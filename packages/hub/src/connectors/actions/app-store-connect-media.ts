import { appStoreConnect, appleResource, relatedId, relation, type AppleResource, type AppStoreConnectApi } from "../app-store-connect-api";
import { record, text } from "../event-format";
import { ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { appAction, appVersionFields, bundleId, LOCALE, versionAction, versionRef } from "./app-store-connect";
import { fileRef, planText } from "./app-store-connect-uploads";
import { quoteRetrievedText } from "./common";
import { cell } from "./google-report";

/*
 * Screenshots through the App Asset Library, which replaced screenshot sets
 * in App Store Connect API 4.5.1: an image is uploaded once into the app's
 * library and then placed on a version's listing for one language and one
 * placement group (a device family). Groups and the exact sizes they accept
 * are Apple's reference data, read at run time; Apple adds device families
 * without an API change, so none is written down here.
 *
 * `set_screenshots` is declarative: the group ends up showing exactly the
 * named images in the named order, so repeating it changes nothing.
 */

const IMAGE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const GROUP = /^[A-Z][A-Z0-9_]{2,80}$/u;
const SCREENSHOT = "APP_SCREENSHOT";
const MAX_SCREENSHOTS = 10;
const MAX_LOCALES = 10;
const STORES: Readonly<Record<string, string>> = { iphone: "IPHONE_APP_STORE", ipad: "IPAD_APP_STORE", mac: "MAC_APP_STORE", tv: "TV_APP_STORE",
  vision: "VISION_PRO_APP_STORE", watch: "WATCH_APP_STORE" };

const list = (value: unknown) => (Array.isArray(value) ? value : []).map(record);

async function localizations(api: AppStoreConnectApi, version: AppleResource): Promise<AppleResource[]> {
  return (await api.list(`/v1/appStoreVersions/${encodeURIComponent(version.id)}/appStoreVersionLocalizations`,
    { "fields[appStoreVersionLocalizations]": "locale", limit: "200" }, 1)).rows;
}

/** A listing's screenshot placements in display order, with the library image each one shows. */
async function placements(api: AppStoreConnectApi, localization: AppleResource, group?: string) {
  const { rows, included } = await api.list(`/v1/appStoreVersionLocalizations/${encodeURIComponent(localization.id)}/placements`, {
    "filter[placementType]": SCREENSHOT, ...(group ? { "filter[placementGroup]": group } : {}), sort: "placementGroupPosition", include: "image",
    "fields[appAssetLibraryPlacements]": "placementType,placementGroup,state,image", "fields[appAssetLibraryImages]": "fileName,state", limit: "200" }, 1);
  const images = new Map(included.filter(row => row.type === "appAssetLibraryImages").map(row => [row.id, row.attributes]));
  return rows.map(row => ({ row, image: relatedId(row, "image") ?? "", file: cell(images.get(relatedId(row, "image") ?? "")?.fileName) }));
}

export const APP_STORE_CONNECT_MEDIA_ACTIONS: Record<string, ConnectorAction> = {
  screenshot_specs: {
    effect: "read", requires: ["keyId", "privateKey"],
    parse(statement) {
      const word = statement.text.trim().toLowerCase();
      return statement.target === "*" && (!word || Object.hasOwn(STORES, word)) ? { store: word ? STORES[word]! : "" }
        : `use @appstoreconnect:screenshot_specs:* [${Object.keys(STORES).join("|")}]`;
    },
    async execute({ credentials }, input) {
      const response = await appStoreConnect(credentials).request("/v1/appAssetLibraryRefData", { query: { "filter[placementTypes]": SCREENSHOT,
        "fields[appAssetLibraryRefData]": "features,placementProfileGroups,imageSpecs,placementTypes" } });
      const catalog = record(appleResource(Array.isArray(response.data) ? response.data[0] : response.data)?.attributes);
      const sizes = new Map(list(catalog.imageSpecs).map(spec => [text(spec.specId), `${cell(record(spec.dimensions).minWidth)}x${cell(record(spec.dimensions).minHeight)}`]));
      const accepted = new Map(list(list(catalog.placementTypes).find(type => type.placementTypeId === SCREENSHOT)?.specMappings)
        .map(mapping => [text(mapping.placementGroupId), (Array.isArray(mapping.specs) ? mapping.specs : []).flatMap(spec => sizes.get(text(spec)) ?? [])]));
      const limits = list(list(list(catalog.features).find(feature => feature.featureId === "APP_STORE_VERSIONS")?.placementPolicies)
        .find(policy => policy.placementType === SCREENSHOT)?.groupLimits);
      const lines = list(catalog.placementProfileGroups).filter(group => accepted.has(text(group.placementProfileGroupId)) && (!input.store || group.platform === input.store))
        .map(group => {
          const id = text(group.placementProfileGroupId);
          const limit = limits.find(entry => Array.isArray(entry.groupIds) && entry.groupIds.includes(id))?.maxCount;
          return [id, cell(group.platform), cell(group.displayClassId), cell(limit ?? "?"), [...new Set(accepted.get(id))].join(" ")].join("\t");
        });
      return { summary: "Screenshot placement groups and the exact image sizes each accepts, from Apple's reference data:\n" +
        quoteRetrievedText(lines.length ? ["group\tstore\tdisplay class\tmax\taccepted sizes", ...lines].join("\n") : "(Apple returned no screenshot groups)") };
    },
  },
  screenshots: versionAction("read", statement => {
    const app = bundleId(statement.target);
    const [word = "", locale = "", ...rest] = statement.text.trim().split(/\s+/u);
    const ref = versionRef(word);
    return app && ref && (!locale || LOCALE.test(locale)) && !rest.length ? { app, ...ref, locale }
      : "name an app and a version, and optionally one language: <com.example.app> <1.2.0> [en-US]";
  }, async ({ api, input, version }) => {
    const all = await localizations(api, version);
    const chosen = all.filter(row => !input.locale || text(row.attributes.locale).toLowerCase() === input.locale.toLowerCase()).slice(0, MAX_LOCALES);
    const lines: string[] = [];
    for (const localization of chosen) {
      const placed = await placements(api, localization);
      lines.push(`${cell(localization.attributes.locale)}: ${placed.length ? "" : "no screenshots"}`);
      let group = "", position = 0;
      for (const item of placed) {
        if (text(item.row.attributes.placementGroup) !== group) { group = text(item.row.attributes.placementGroup); position = 0; lines.push(`  ${group}`); }
        lines.push(`    ${position += 1}\timage ${item.image}\t${item.file}\t${cell(item.row.attributes.state)}`);
      }
    }
    return `Screenshots of ${input.app} ${input.version}, in display order${all.length > chosen.length && !input.locale ? ` (first ${MAX_LOCALES} languages)` : ""}:\n` +
      quoteRetrievedText(lines.length ? lines.join("\n") : `(no ${input.locale || ""} listing on this version)`);
  }),
  upload_screenshot: appAction("write", statement => {
    const app = bundleId(statement.target), file = fileRef(statement.text.trim().split(/\s+/u));
    return app && file && /\.(?:png|jpe?g)$/iu.test(file.fileName) ? { app, ...file }
      : "name an app, the .png or .jpg file's name and its size in bytes: <com.example.app> <home-6.9.png> <1482113>";
  }, async ({ api, app, input }) => {
    const library = appleResource((await api.request(`/v1/apps/${encodeURIComponent(app.id)}/assetLibrary`)).data);
    if (!library) throw new ProviderRequestError(502, "App Store Connect did not return the app's asset library");
    const image = appleResource((await api.request("/v1/appAssetLibraryImages", { method: "POST", data: { type: "appAssetLibraryImages",
      attributes: { category: "APP_SCREENSHOTS_AND_PREVIEWS", fileName: input.fileName, fileSize: Number(input.fileSize) },
      relationships: { assetLibrary: relation("appAssetLibraries", library.id) } } })).data);
    if (!image) throw new ProviderRequestError(502, "App Store Connect did not return the image reservation");
    return `Reserved image ${image.id} in the asset library of ${input.app}, file ${input.fileName}. ` + planText("image", image.id, image);
  }),
  set_screenshots: versionAction("write", statement => {
    const usage = 'name an app, a version, a language, a placement group and the library images in display order: <com.example.app> <1.2.0> {"locale":"en-US","group":"<group from screenshot_specs>","images":["<image id>"]}';
    const parsed = appVersionFields(statement, usage, 4_000);
    if (typeof parsed === "string") return parsed;
    const { locale, group, images, ...other } = parsed.fields;
    if (Object.keys(other).length || typeof locale !== "string" || !LOCALE.test(locale) || typeof group !== "string" || !GROUP.test(group) ||
        !Array.isArray(images) || images.length > MAX_SCREENSHOTS || new Set(images).size !== images.length ||
        images.some(image => typeof image !== "string" || !IMAGE_ID.test(image))) return usage;
    return { app: parsed.app, platform: parsed.platform, version: parsed.version, locale, group, images: JSON.stringify(images) };
  }, async ({ api, input, version }) => {
    const localization = (await localizations(api, version)).find(row => text(row.attributes.locale).toLowerCase() === input.locale!.toLowerCase());
    if (!localization) throw new ProviderRequestError(404, `Version ${input.version} has no ${input.locale} listing; create it with set_metadata first`);
    const wanted = JSON.parse(input.images!) as string[];
    const current = await placements(api, localization, input.group);
    /* Removed first: a full group has no room for the new placements otherwise. */
    const removed = current.filter(item => !wanted.includes(item.image));
    for (const item of removed) await api.request(`/v1/appAssetLibraryPlacements/${encodeURIComponent(item.row.id)}`, { method: "DELETE" });
    const ordered: string[] = [];
    let added = 0;
    for (const image of wanted) {
      const existing = current.find(item => item.image === image);
      const placed = existing?.row ?? appleResource((await api.request("/v1/appAssetLibraryPlacements", { method: "POST", data: { type: "appAssetLibraryPlacements",
        attributes: { placementType: SCREENSHOT, placementGroup: input.group }, relationships: { image: relation("appAssetLibraryImages", image),
          appStoreVersionLocalization: relation("appStoreVersionLocalizations", localization.id) } } })).data);
      if (!placed) throw new ProviderRequestError(502, "App Store Connect did not return the placement");
      if (!existing) added += 1;
      ordered.push(placed.id);
    }
    if (ordered.length > 1) {
      await api.request("/v1/appAssetLibraryPlacementOrderingRequests", { method: "POST", data: { type: "appAssetLibraryPlacementOrderingRequests",
        attributes: { placementGroup: input.group }, relationships: { orderedPlacements: { data: ordered.map(id => ({ type: "appAssetLibraryPlacements", id })) },
          appStoreVersionLocalization: relation("appStoreVersionLocalizations", localization.id) } } });
    }
    return `${input.locale} ${input.group} of ${input.app} ${input.version} now shows ${ordered.length} screenshot(s) in the given order: ` +
      `${added} placed, ${removed.length} removed, ${ordered.length - added} kept.`;
  }),
};
