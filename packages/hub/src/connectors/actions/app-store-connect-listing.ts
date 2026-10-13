import { appleResource, relatedId, relatedIds, relation, type AppleResource, type AppStoreConnectApi } from "../app-store-connect-api";
import { text } from "../event-format";
import { ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { appAction, appVersionFields, bundleId, jsonFields, LOCALE, MAX_OUTPUT, reviewDetail, textFieldProblem, versionAction } from "./app-store-connect";
import { quoteRetrievedText } from "./common";
import { cell, keyedOptions } from "./google-report";

/*
 * What a new app needs once before its first submission, and that App Store
 * Connect keeps per app rather than per version: its name, subtitle and
 * privacy policy per language, its categories, the content rights and age
 * rating declarations, its price, and the App Review contact. `read_app`
 * prints them in the shape the `set_` actions take back.
 *
 * An app has up to two app infos: the one on the store and the one that goes
 * live with the next version. Writes go to the one that is not live.
 *
 * Declarations are the developer's statements to Apple: nothing here has a
 * default, and every value comes from the statement.
 */

const TERRITORY = /^[A-Z]{3}$/u;
const CATEGORY = /^[A-Z][A-Z0-9_]{1,60}$/u;
const MAX_FIELDS_TEXT = 6_000;
/* An existing availability changes one territory per call to Apple; a statement may flip this many. */
const MAX_TERRITORY_CHANGES = 25;
const LIVE_INFO_STATES: ReadonlySet<string> = new Set(["READY_FOR_DISTRIBUTION", "READY_FOR_SALE", "REPLACED_WITH_NEW_INFO"]);
const INFO_TEXT_LIMITS: Readonly<Record<string, number>> = { name: 30, subtitle: 30, privacyPolicyUrl: 1_000, privacyChoicesUrl: 1_000 };
const CONTENT_RIGHTS = ["DOES_NOT_USE_THIRD_PARTY_CONTENT", "USES_THIRD_PARTY_CONTENT"];
const CONTACT_LIMITS: Readonly<Record<string, number>> = { contactFirstName: 100, contactLastName: 100, contactEmail: 255, contactPhone: 30,
  demoAccountName: 255, notes: 4_000 };

/* Apple's age rating questionnaire: yes/no answers, frequency answers, and the few with their own vocabulary. */
const AGE_FLAGS = ["advertising", "gambling", "healthOrWellnessTopics", "lootBox", "messagingAndChat", "parentalControls", "ageAssurance",
  "socialMedia", "socialMediaAgeRestricted", "unrestrictedWebAccess", "userGeneratedContent"];
const AGE_LEVELS = ["alcoholTobaccoOrDrugUseOrReferences", "contests", "gamblingSimulated", "gunsOrOtherWeapons", "medicalOrTreatmentInformation",
  "profanityOrCrudeHumor", "sexualContentGraphicAndNudity", "sexualContentOrNudity", "horrorOrFearThemes", "matureOrSuggestiveThemes",
  "violenceCartoonOrFantasy", "violenceRealisticProlongedGraphicOrSadistic", "violenceRealistic"];
/* API 4.1 deprecated the two older spellings; they are still taken, and the hint names the current ones. */
const LEVELS = ["NONE", "INFREQUENT", "FREQUENT", "INFREQUENT_OR_MILD", "FREQUENT_OR_INTENSE"];
const AGE_CHOICES: Readonly<Record<string, readonly (string | null)[]>> = {
  kidsAgeBand: ["FIVE_AND_UNDER", "SIX_TO_EIGHT", "NINE_TO_ELEVEN", null],
  ageRatingOverrideV2: ["NONE", "NINE_PLUS", "THIRTEEN_PLUS", "SIXTEEN_PLUS", "EIGHTEEN_PLUS", "UNRATED"],
  koreaAgeRatingOverride: ["NONE", "ALL", "TWELVE_PLUS", "FIFTEEN_PLUS", "NINETEEN_PLUS"],
};
const AGE_FIELDS = [...AGE_FLAGS, ...AGE_LEVELS, ...Object.keys(AGE_CHOICES), "developerAgeRatingInfoUrl"];

const infoState = (row: AppleResource) => text(row.attributes.state) || text(row.attributes.appStoreState) || "UNKNOWN";

async function appInfos(api: AppStoreConnectApi, app: AppleResource) {
  const { rows, included } = await api.list(`/v1/apps/${encodeURIComponent(app.id)}/appInfos`, {
    include: "primaryCategory,secondaryCategory,appInfoLocalizations,ageRatingDeclaration", limit: "10", "limit[appInfoLocalizations]": "50",
    "fields[appInfos]": "state,appStoreState,appStoreAgeRating,primaryCategory,secondaryCategory,appInfoLocalizations,ageRatingDeclaration",
    "fields[appInfoLocalizations]": "locale,name,subtitle,privacyPolicyUrl,privacyChoicesUrl" }, 1);
  if (!rows.length) throw new ProviderRequestError(404, "App Store Connect returned no app info for this app");
  const byId = new Map(included.map(row => [`${row.type}:${row.id}`, row]));
  return { rows, localizations: (info: AppleResource) => relatedIds(info, "appInfoLocalizations").flatMap(id => byId.get(`appInfoLocalizations:${id}`) ?? []),
    declaration: (info: AppleResource) => byId.get(`ageRatingDeclarations:${relatedId(info, "ageRatingDeclaration") ?? ""}`) };
}

/** The app info the next version carries; the only one a new app has. */
function editableInfo(rows: AppleResource[]): AppleResource {
  return rows.find(row => !LIVE_INFO_STATES.has(infoState(row))) ?? rows[0]!;
}

/** A read that answers nothing where the app has not set the thing up yet. */
async function optional<T>(read: Promise<T>): Promise<T | undefined> {
  try { return await read; } catch (error) {
    if (error instanceof ProviderRequestError && error.status === 404) return undefined;
    throw error;
  }
}

async function priceLines(api: AppStoreConnectApi, app: AppleResource): Promise<string[]> {
  const schedule = appleResource((await optional(api.request(`/v1/apps/${encodeURIComponent(app.id)}/appPriceSchedule`,
    { query: { include: "baseTerritory", "fields[appPriceSchedules]": "baseTerritory" } })))?.data);
  if (!schedule) return ["price: not set"];
  const { rows, included } = await api.list(`/v1/appPriceSchedules/${encodeURIComponent(schedule.id)}/manualPrices`, { include: "appPricePoint,territory",
    "fields[appPrices]": "startDate,endDate,appPricePoint,territory", "fields[appPricePoints]": "customerPrice", limit: "20" }, 1);
  const points = new Map(included.filter(row => row.type === "appPricePoints").map(row => [row.id, text(row.attributes.customerPrice)]));
  return [`price (base territory ${relatedId(schedule, "baseTerritory") ?? "?"}):`, ...rows.map(price => `  ${relatedId(price, "territory") ?? "?"} ` +
    `${points.get(relatedId(price, "appPricePoint") ?? "") ?? "?"} from ${cell(price.attributes.startDate) || "now"} to ${cell(price.attributes.endDate) || "open"}`)];
}

/** Why one questionnaire answer is refused, if it is: every answer is checked against Apple's own vocabulary. */
function ageAnswerProblem(name: string, value: unknown): string | undefined {
  if (AGE_FLAGS.includes(name)) return typeof value === "boolean" ? undefined : `${name} is true or false`;
  if (AGE_LEVELS.includes(name)) return LEVELS.includes(value as string) ? undefined : `${name} is one of ${LEVELS.slice(0, 3).join(", ")}`;
  if (Object.hasOwn(AGE_CHOICES, name)) return AGE_CHOICES[name]!.includes(value as string | null) ? undefined : `${name} is one of ${AGE_CHOICES[name]!.join(", ")}`;
  return name === "developerAgeRatingInfoUrl" ? textFieldProblem(name, value, 1_000) : `${name} is not an age rating answer; read_app lists them`;
}

/** `{json}` after the app: validated members, or why they are refused. */
function appFields(statement: { target: string; text: string }, usage: string): { app: string; fields: Record<string, unknown> } | string {
  const app = bundleId(statement.target), json = statement.text.trim();
  if (!app || !json || json.length > MAX_FIELDS_TEXT) return usage;
  const fields = jsonFields(json);
  return fields && Object.keys(fields).length ? { app, fields } : usage;
}

export const APP_STORE_CONNECT_LISTING_ACTIONS: Record<string, ConnectorAction> = {
  read_app: appAction("read",
    statement => bundleId(statement.target) && !statement.text.trim() ? { app: statement.target } : "name an app by its bundle ID: <com.example.app>",
    async ({ api, app, input }) => {
      const [infos, price, availability] = await Promise.all([appInfos(api, app), priceLines(api, app),
        optional(api.request(`/v1/apps/${encodeURIComponent(app.id)}/appAvailabilityV2`, { query: { "fields[appAvailabilities]": "availableInNewTerritories" } }))]);
      const available = appleResource(availability?.data);
      const lines = [`content rights: ${cell(app.attributes.contentRightsDeclaration) || "not declared"}`, ...price,
        `availability: ${available ? `set; new territories ${available.attributes.availableInNewTerritories === true ? "included" : "not included"}` : "not set"}`,
        ...infos.rows.flatMap(info => {
          const declared = infos.declaration(info)?.attributes ?? {};
          return [`app info (${infoState(info)}), age rating ${cell(info.attributes.appStoreAgeRating) || "not rated"}, ` +
            `categories ${relatedId(info, "primaryCategory") ?? "none"} / ${relatedId(info, "secondaryCategory") ?? "none"}:`,
          ...infos.localizations(info).map(row => JSON.stringify({ locale: text(row.attributes.locale),
            ...Object.fromEntries(Object.keys(INFO_TEXT_LIMITS).flatMap(field => text(row.attributes[field]) ? [[field, text(row.attributes[field])]] : [])) })),
          `age rating answers: ${JSON.stringify(Object.fromEntries(AGE_FIELDS.flatMap(field => declared[field] === undefined ? [] : [[field, declared[field]]])))}`];
        })];
      return `App record of ${input.app}; names and URLs are untrusted:\n` + quoteRetrievedText(lines.join("\n"), MAX_OUTPUT);
    }),
  set_app_info: appAction("write", statement => {
    const usage = 'name an app and what to set: <com.example.app> {"locale":"en-US","name":"…","subtitle":"…","privacyPolicyUrl":"https://…","primaryCategory":"PRODUCTIVITY"}';
    const parsed = appFields(statement, usage);
    if (typeof parsed === "string") return parsed;
    const { locale, primaryCategory, secondaryCategory, contentRightsDeclaration, ...localized } = parsed.fields;
    const names = Object.keys(localized);
    if (!names.length && [primaryCategory, secondaryCategory, contentRightsDeclaration].every(value => value === undefined)) return usage;
    if (names.some(name => !Object.hasOwn(INFO_TEXT_LIMITS, name))) {
      return `set any of ${Object.keys(INFO_TEXT_LIMITS).join(", ")} (with locale), primaryCategory, secondaryCategory, contentRightsDeclaration`;
    }
    const problem = names.map(name => textFieldProblem(name, localized[name], INFO_TEXT_LIMITS[name]!)).find(Boolean);
    if (problem) return problem;
    if (names.length && (typeof locale !== "string" || !LOCALE.test(locale))) return 'name the language of the name, subtitle and URLs: "locale":"en-US"';
    for (const category of [primaryCategory, secondaryCategory]) {
      if (category !== undefined && (typeof category !== "string" || !CATEGORY.test(category))) return "a category is Apple's id, such as PRODUCTIVITY or GAMES";
    }
    if (contentRightsDeclaration !== undefined && !CONTENT_RIGHTS.includes(contentRightsDeclaration as string)) return `contentRightsDeclaration is ${CONTENT_RIGHTS.join(" or ")}`;
    return { app: parsed.app, locale: typeof locale === "string" ? locale : "", localized: JSON.stringify(localized),
      categories: JSON.stringify({ primaryCategory, secondaryCategory }), rights: typeof contentRightsDeclaration === "string" ? contentRightsDeclaration : "" };
  }, async ({ api, app, input }) => {
    const infos = await appInfos(api, app);
    const info = editableInfo(infos.rows);
    const localized = JSON.parse(input.localized!) as Record<string, string>;
    const categories = Object.entries(JSON.parse(input.categories!) as Record<string, string>);
    const changed = [...Object.keys(localized).map(name => `${input.locale} ${name}`), ...categories.map(([name]) => name), ...(input.rights ? ["contentRightsDeclaration"] : [])];
    if (Object.keys(localized).length) {
      const existing = infos.localizations(info).find(row => text(row.attributes.locale).toLowerCase() === input.locale!.toLowerCase());
      if (existing) {
        await api.request(`/v1/appInfoLocalizations/${encodeURIComponent(existing.id)}`, { method: "PATCH",
          data: { type: "appInfoLocalizations", id: existing.id, attributes: localized } });
      } else {
        await api.request("/v1/appInfoLocalizations", { method: "POST", data: { type: "appInfoLocalizations",
          attributes: { locale: input.locale, ...localized }, relationships: { appInfo: relation("appInfos", info.id) } } });
      }
    }
    if (categories.length) {
      await api.request(`/v1/appInfos/${encodeURIComponent(info.id)}`, { method: "PATCH", data: { type: "appInfos", id: info.id,
        relationships: Object.fromEntries(categories.map(([name, id]) => [name, relation("appCategories", id)])) } });
    }
    if (input.rights) {
      await api.request(`/v1/apps/${encodeURIComponent(app.id)}`, { method: "PATCH", data: { type: "apps", id: app.id, attributes: { contentRightsDeclaration: input.rights } } });
    }
    return `Updated ${changed.join(", ")} of ${input.app} (app info ${infoState(info)}).`;
  }),
  set_age_rating: appAction("write", statement => {
    const parsed = appFields(statement, 'name an app and the questionnaire answers to set: <com.example.app> {"gambling":false,"violenceRealistic":"NONE","userGeneratedContent":true}');
    if (typeof parsed === "string") return parsed;
    const problem = Object.entries(parsed.fields).map(([name, value]) => ageAnswerProblem(name, value)).find(Boolean);
    return problem ?? { app: parsed.app, answers: JSON.stringify(parsed.fields) };
  }, async ({ api, app, input }) => {
    const infos = await appInfos(api, app);
    const info = editableInfo(infos.rows);
    const declaration = relatedId(info, "ageRatingDeclaration");
    if (!declaration) throw new ProviderRequestError(502, "App Store Connect did not return the app's age rating declaration");
    const answers = JSON.parse(input.answers!) as Record<string, unknown>;
    await api.request(`/v1/ageRatingDeclarations/${encodeURIComponent(declaration)}`, { method: "PATCH",
      data: { type: "ageRatingDeclarations", id: declaration, attributes: answers } });
    return `Set ${Object.keys(answers).length} age rating answer(s) of ${input.app}: ${Object.keys(answers).join(", ")}. Apple computes the rating from all answers; read_app shows it.`;
  }),
  set_price: appAction("write", statement => {
    const app = bundleId(statement.target);
    const [amount = "", territory = "USA", ...rest] = statement.text.trim().split(/\s+/u);
    const price = amount.toLowerCase() === "free" ? "0" : /^\d{1,5}(?:\.\d{1,2})?$/u.test(amount) ? amount : undefined;
    return app && price && TERRITORY.test(territory) && !rest.length ? { app, price, territory }
      : "name an app and its price in the base territory: <com.example.app> free, or <com.example.app> 4.99 [USA]";
  }, async ({ api, app, input }) => {
    const { rows } = await api.list(`/v1/apps/${encodeURIComponent(app.id)}/appPricePoints`, { "filter[territory]": input.territory!,
      "fields[appPricePoints]": "customerPrice", limit: "200" });
    const point = rows.find(row => text(row.attributes.customerPrice) !== "" && Number(row.attributes.customerPrice) === Number(input.price));
    if (!point) throw new ProviderRequestError(404, `Apple has no ${input.price} price point in ${input.territory}; choose one of its price points`);
    /* One price from now on, in the base territory; Apple derives every other territory's price from it. */
    await api.request("/v1/appPriceSchedules", { method: "POST",
      data: { type: "appPriceSchedules", attributes: {}, relationships: { app: relation("apps", app.id), baseTerritory: relation("territories", input.territory!),
        manualPrices: { data: [{ type: "appPrices", id: "${price}" }] } } },
      included: [{ type: "appPrices", id: "${price}", attributes: { startDate: null, endDate: null },
        relationships: { appPricePoint: relation("appPricePoints", point.id) } }] });
    return `Set the price of ${input.app} to ${Number(input.price) === 0 ? "free" : `${input.price} in ${input.territory}`}; Apple derives the other territories' prices from it.`;
  }),
  set_availability: appAction("write", statement => {
    const usage = "name an app and where it is sold: <com.example.app> all, or <com.example.app> USA,CAN,GBR [new=on|off]";
    const app = bundleId(statement.target);
    const [where = "", ...rest] = statement.text.trim().split(/\s+/u);
    const options = keyedOptions(rest.join(" "), ["new"], usage);
    const territories = where.toLowerCase() === "all" ? [] : where.split(",");
    const future = typeof options === "string" ? undefined : { on: "true", off: "false" }[options.get("new") ?? "on"];
    if (!app || !where || !future || territories.length > 250 || new Set(territories).size !== territories.length ||
        territories.some(code => !TERRITORY.test(code))) return usage;
    return { app, territories: territories.join(","), future };
  }, async ({ api, app, input }) => {
    const known = (await api.list("/v1/territories", { limit: "200" })).rows.map(row => row.id);
    const chosen = input.territories ? input.territories.split(",") : known;
    const unknown = chosen.filter(code => !known.includes(code));
    if (unknown.length) throw new ProviderRequestError(400, `Apple has no territory ${unknown.slice(0, 10).join(", ")}; use its three-letter codes, such as USA`);
    const existing = appleResource((await optional(api.request(`/v1/apps/${encodeURIComponent(app.id)}/appAvailabilityV2`)))?.data);
    if (!existing) {
      /* A first availability is one request naming every territory; nothing is left to Apple's default. */
      const local = (code: string) => `\${territory-${code}}`;
      await api.request("/v2/appAvailabilities", { method: "POST",
        data: { type: "appAvailabilities", attributes: { availableInNewTerritories: input.future === "true" },
          relationships: { app: relation("apps", app.id), territoryAvailabilities: { data: known.map(code => ({ type: "territoryAvailabilities", id: local(code) })) } } },
        included: known.map(code => ({ type: "territoryAvailabilities", id: local(code), attributes: { available: chosen.includes(code) },
          relationships: { territory: relation("territories", code) } })) });
      return `Made ${input.app} available in ${chosen.length} of ${known.length} territories; new territories are ${input.future === "true" ? "" : "not "}added automatically.`;
    }
    const current = (await api.list(`/v2/appAvailabilities/${encodeURIComponent(existing.id)}/territoryAvailabilities`,
      { include: "territory", "fields[territoryAvailabilities]": "available,territory", limit: "200" })).rows;
    const changes = current.filter(row => relatedId(row, "territory") && (row.attributes.available === true) !== chosen.includes(relatedId(row, "territory")!));
    if (changes.length > MAX_TERRITORY_CHANGES) {
      throw new ProviderRequestError(409, `That changes ${changes.length} territories of an existing availability; change at most ${MAX_TERRITORY_CHANGES} per statement`);
    }
    for (const row of changes) {
      await api.request(`/v1/territoryAvailabilities/${encodeURIComponent(row.id)}`, { method: "PATCH",
        data: { type: "territoryAvailabilities", id: row.id, attributes: { available: row.attributes.available !== true } } });
    }
    return `${input.app} is now available in ${chosen.length} territories; changed ${changes.length}` +
      (changes.length ? `: ${changes.map(row => `${relatedId(row, "territory")} ${row.attributes.available === true ? "off" : "on"}`).join(", ")}.` : ".") +
      " Whether new territories are added automatically is set when the availability is first created.";
  }),
  set_review_contact: versionAction("write", statement => {
    const parsed = appVersionFields(statement,
      'name an app, a version and the App Review contact: <com.example.app> <1.0.0> {"contactFirstName":"…","contactLastName":"…","contactEmail":"…","contactPhone":"+1…"}', MAX_FIELDS_TEXT);
    if (typeof parsed === "string") return parsed;
    const { demoAccountRequired, ...texts } = parsed.fields;
    const names = Object.keys(texts);
    if ((!names.length && demoAccountRequired === undefined) || names.some(name => !Object.hasOwn(CONTACT_LIMITS, name))) {
      return `set any of ${Object.keys(CONTACT_LIMITS).join(", ")}, demoAccountRequired; the sign-in password is entered in App Store Connect, never here`;
    }
    const problem = names.map(name => textFieldProblem(name, texts[name], CONTACT_LIMITS[name]!)).find(Boolean);
    if (problem) return problem;
    if (demoAccountRequired !== undefined && typeof demoAccountRequired !== "boolean") return "demoAccountRequired is true or false";
    return { app: parsed.app, platform: parsed.platform, version: parsed.version, contact: JSON.stringify(parsed.fields) };
  }, async ({ api, input, version }) => {
    const attributes = JSON.parse(input.contact!) as Record<string, unknown>;
    const existing = await reviewDetail(api, version);
    /* These calls carry personal contact data: Apple's error text stays out of the receipt. */
    if (existing) {
      await api.request(`/v1/appStoreReviewDetails/${encodeURIComponent(existing.id)}`, { method: "PATCH", quiet: true,
        data: { type: "appStoreReviewDetails", id: existing.id, attributes } });
    } else {
      await api.request("/v1/appStoreReviewDetails", { method: "POST", quiet: true, data: { type: "appStoreReviewDetails", attributes,
        relationships: { appStoreVersion: relation("appStoreVersions", version.id) } } });
    }
    return `Set the App Review ${Object.keys(attributes).join(", ")} of ${input.app} ${input.version}.` +
      (attributes.demoAccountRequired === true ? " Enter the sign-in password in App Store Connect; it is never taken from a channel." : "");
  }),
};
