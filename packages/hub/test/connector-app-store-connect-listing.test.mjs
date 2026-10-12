import assert from "node:assert/strict";
import { test } from "node:test";

import { ACTIONS, apps, BUNDLE, credentials, run, statement, version, versions, withApple, writes } from "./support/app-store-connect-double.mjs";

/* An app with the info on the store and the info its next version carries. */
const info = (id, state, extra = {}) => ({ type: "appInfos", id, attributes: { state, appStoreAgeRating: "FOUR_PLUS" }, relationships: {
  primaryCategory: { data: { type: "appCategories", id: "PRODUCTIVITY" } }, secondaryCategory: { data: null },
  appInfoLocalizations: { data: [{ type: "appInfoLocalizations", id: `${id}-en` }] },
  ageRatingDeclaration: { data: { type: "ageRatingDeclarations", id } }, ...extra } });
const localization = (id, attributes) => ({ type: "appInfoLocalizations", id, attributes: { locale: "en-US", ...attributes } });
const infos = (...rows) => ({ "GET /v1/apps/6760000001/appInfos": { data: rows, included: [
  ...rows.map((row) => localization(`${row.id}-en`, { name: `Example ${row.id}`, privacyPolicyUrl: "https://example.com/privacy" })),
  ...rows.map((row) => ({ type: "ageRatingDeclarations", id: row.id, attributes: { gambling: false, violenceRealistic: "NONE", kidsAgeBand: null, internalOnly: "x" } })),
] } });
const fresh = infos(info("next", "PREPARE_FOR_SUBMISSION"));
const execute = (action, input, routes) => withApple(routes, () => ACTIONS[action].execute({ credentials }, input));

test("read_app shows what a new app still lacks, in the shape the set actions take back", async () => {
  const unset = await run({ ...apps, ...fresh }, `@appstoreconnect:read_app:${BUNDLE}`);
  assert.match(unset.value.summary, /content rights: not declared\nprice: not set\navailability: not set\n/u);
  assert.match(unset.value.summary, /app info \(PREPARE_FOR_SUBMISSION\), age rating FOUR_PLUS, categories PRODUCTIVITY \/ none:/u);
  assert.match(unset.value.summary, /\{"locale":"en-US","name":"Example next","privacyPolicyUrl":"https:\/\/example\.com\/privacy"\}/u);
  assert.match(unset.value.summary, /age rating answers: \{"gambling":false,"violenceRealistic":"NONE","kidsAgeBand":null\}/u, "only questionnaire answers, unanswered ones as null");
  assert.deepEqual(writes(unset.calls), []);

  const priced = await run({ "GET /v1/apps": { data: [{ type: "apps", id: "6760000001", attributes: { bundleId: BUNDLE, contentRightsDeclaration: "DOES_NOT_USE_THIRD_PARTY_CONTENT" } }] },
    ...infos(info("live", "READY_FOR_DISTRIBUTION"), info("next", "PREPARE_FOR_SUBMISSION")),
    "GET /v1/apps/6760000001/appPriceSchedule": { data: { type: "appPriceSchedules", id: "sched-1", relationships: { baseTerritory: { data: { type: "territories", id: "USA" } } } } },
    "GET /v1/appPriceSchedules/sched-1/manualPrices": { data: [{ type: "appPrices", id: "p-1", attributes: { startDate: null, endDate: null },
      relationships: { appPricePoint: { data: { type: "appPricePoints", id: "pt-0" } }, territory: { data: { type: "territories", id: "USA" } } } }],
    included: [{ type: "appPricePoints", id: "pt-0", attributes: { customerPrice: "0.0" } }] },
    "GET /v1/apps/6760000001/appAvailabilityV2": { data: { type: "appAvailabilities", id: "6760000001", attributes: { availableInNewTerritories: true } } } },
  `@appstoreconnect:read_app:${BUNDLE}`);
  assert.match(priced.value.summary, /content rights: DOES_NOT_USE_THIRD_PARTY_CONTENT\nprice \(base territory USA\):\n {2}USA 0\.0 from now to open\navailability: set; new territories included\n/u);
  assert.match(priced.value.summary, /app info \(READY_FOR_DISTRIBUTION\)[\s\S]*app info \(PREPARE_FOR_SUBMISSION\)/u);
});

test("listing statements are validated to Apple's vocabulary before any request", () => {
  assert.deepEqual(statement(`@appstoreconnect:set_app_info:${BUNDLE} {"locale":"en-US","name":"Example","primaryCategory":"GAMES"}`),
    { app: BUNDLE, locale: "en-US", localized: '{"name":"Example"}', categories: '{"primaryCategory":"GAMES"}', rights: "" });
  assert.deepEqual(statement(`@appstoreconnect:set_price:${BUNDLE} free`), { app: BUNDLE, price: "0", territory: "USA" });
  assert.deepEqual(statement(`@appstoreconnect:set_price:${BUNDLE} 4.99 CAN`), { app: BUNDLE, price: "4.99", territory: "CAN" });
  assert.deepEqual(statement(`@appstoreconnect:set_age_rating:${BUNDLE} {"gambling":false,"contests":"INFREQUENT_OR_MILD","kidsAgeBand":null}`),
    { app: BUNDLE, answers: '{"gambling":false,"contests":"INFREQUENT_OR_MILD","kidsAgeBand":null}' });
  for (const bad of [`set_app_info:${BUNDLE} {"name":"no locale"}`, `set_app_info:${BUNDLE} {"locale":"en-US"}`, `set_app_info:${BUNDLE} {"locale":"en-US","name":"${"n".repeat(31)}"}`,
    `set_app_info:${BUNDLE} {"primaryCategory":"productivity"}`, `set_app_info:${BUNDLE} {"contentRightsDeclaration":"NONE"}`,
    `set_app_info:${BUNDLE} {"locale":"en-US","privacyPolicyUrl":"http://example.com"}`, `set_app_info:${BUNDLE} {"locale":"en-US","description":"version text"}`,
    `set_age_rating:${BUNDLE} {}`, `set_age_rating:${BUNDLE} {"gambling":"NONE"}`, `set_age_rating:${BUNDLE} {"contests":"SOMETIMES"}`,
    `set_age_rating:${BUNDLE} {"contests":true}`, `set_age_rating:${BUNDLE} {"kidsAgeBand":"TEENS"}`, `set_age_rating:${BUNDLE} {"__proto__":true}`,
    `set_age_rating:${BUNDLE} {"appStoreAgeRating":"FOUR_PLUS"}`, `set_price:${BUNDLE} cheap`, `set_price:${BUNDLE} 4.999`, `set_price:${BUNDLE} 4.99 usa`,
    `set_review_contact:${BUNDLE} 1.0 {"demoAccountPassword":"hunter2"}`, `set_review_contact:${BUNDLE} 1.0 {"demoAccountRequired":"yes"}`,
    `set_review_contact:${BUNDLE} {"contactEmail":"a@example.com"}`, `set_review_contact:${BUNDLE} 1.0 {}`]) {
    assert.equal(typeof statement(`@appstoreconnect:${bad}`), "string", bad);
  }
  assert.match(statement(`@appstoreconnect:set_review_contact:${BUNDLE} 1.0 {"demoAccountPassword":"hunter2"}`), /never here/u);
});

test("set_app_info writes to the app info that is not live", async () => {
  const both = { ...apps, ...infos(info("live", "READY_FOR_DISTRIBUTION"), info("next", "PREPARE_FOR_SUBMISSION")) };
  const updated = await run({ ...both, "PATCH /v1/appInfoLocalizations/next-en": { data: {} }, "PATCH /v1/appInfos/next": { data: {} }, "PATCH /v1/apps/6760000001": { data: {} } },
    `@appstoreconnect:set_app_info:${BUNDLE} {"locale":"en-us","subtitle":"Ship faster","primaryCategory":"DEVELOPER_TOOLS","contentRightsDeclaration":"DOES_NOT_USE_THIRD_PARTY_CONTENT"}`);
  assert.deepEqual(writes(updated.calls), ["PATCH /v1/appInfoLocalizations/next-en", "PATCH /v1/appInfos/next", "PATCH /v1/apps/6760000001"]);
  const [text, categories, rights] = updated.calls.filter((call) => call.method === "PATCH").map((call) => call.body);
  assert.deepEqual(text.attributes, { subtitle: "Ship faster" });
  assert.deepEqual(categories.relationships, { primaryCategory: { data: { type: "appCategories", id: "DEVELOPER_TOOLS" } } });
  assert.deepEqual(rights.attributes, { contentRightsDeclaration: "DOES_NOT_USE_THIRD_PARTY_CONTENT" });
  assert.match(updated.value.summary, /\(app info PREPARE_FOR_SUBMISSION\)/u);

  const added = await run({ ...apps, ...fresh, "POST /v1/appInfoLocalizations": { data: {} } }, `@appstoreconnect:set_app_info:${BUNDLE} {"locale":"ja","name":"例"}`);
  assert.deepEqual(added.calls.at(-1).body, { type: "appInfoLocalizations", attributes: { locale: "ja", name: "例" },
    relationships: { appInfo: { data: { type: "appInfos", id: "next" } } } });
});

test("set_age_rating sends exactly the answers given to the editable declaration", async () => {
  const answers = { gambling: false, violenceRealistic: "NONE", userGeneratedContent: true };
  const set = await run({ ...apps, ...infos(info("live", "READY_FOR_DISTRIBUTION"), info("next", "PREPARE_FOR_SUBMISSION")),
    "PATCH /v1/ageRatingDeclarations/next": { data: {} } }, `@appstoreconnect:set_age_rating:${BUNDLE} ${JSON.stringify(answers)}`);
  assert.deepEqual(set.calls.at(-1).body, { type: "ageRatingDeclarations", id: "next", attributes: answers }, "no answer is added or defaulted");
});

test("set_price posts one price point of the base territory, and refuses an amount Apple does not offer", async () => {
  const points = { "GET /v1/apps/6760000001/appPricePoints": { data: [{ type: "appPricePoints", id: "pt-0", attributes: { customerPrice: "0.0" } },
    { type: "appPricePoints", id: "pt-499", attributes: { customerPrice: "4.99" } }] } };
  const free = await run({ ...apps, ...points, "POST /v1/appPriceSchedules": { data: {} } }, `@appstoreconnect:set_price:${BUNDLE} free`);
  const post = free.calls.at(-1);
  assert.equal(free.calls.find((call) => call.path.endsWith("/appPricePoints")).query["filter[territory]"], "USA");
  assert.deepEqual(post.body.relationships, { app: { data: { type: "apps", id: "6760000001" } }, baseTerritory: { data: { type: "territories", id: "USA" } },
    manualPrices: { data: [{ type: "appPrices", id: "${price}" }] } });
  assert.deepEqual(post.included, [{ type: "appPrices", id: "${price}", attributes: { startDate: null, endDate: null },
    relationships: { appPricePoint: { data: { type: "appPricePoints", id: "pt-0" } } } }]);
  assert.match(free.value.summary, /to free;/u);
  const refused = await execute("set_price", { app: BUNDLE, price: "3.33", territory: "USA" }, { ...apps, ...points }).catch((error) => error);
  assert.match(refused.message, /no 3\.33 price point in USA/u);
});

test("set_review_contact updates or creates the details and keeps their values out of the receipt", async () => {
  const open = { ...apps, ...versions(version("v1", "1.0.0", "PREPARE_FOR_SUBMISSION")) };
  const contact = { contactFirstName: "Ada", contactEmail: "ada@example.com", contactPhone: "+1 555 0100", demoAccountRequired: true, demoAccountName: "demo" };
  const created = await run({ ...open, "POST /v1/appStoreReviewDetails": { data: {} } }, `@appstoreconnect:set_review_contact:${BUNDLE} 1.0.0 ${JSON.stringify(contact)}`);
  assert.deepEqual(created.calls.at(-1).body, { type: "appStoreReviewDetails", attributes: contact, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "v1" } } } });
  assert.match(created.value.summary, /Set the App Review contactFirstName, contactEmail, contactPhone, demoAccountRequired, demoAccountName .* Enter the sign-in password in App Store Connect/u);
  assert.doesNotMatch(created.value.summary, /Ada|ada@example\.com|555/u);

  const patched = await run({ ...open, "GET /v1/appStoreVersions/v1/appStoreReviewDetail": { data: { type: "appStoreReviewDetails", id: "rd-1", attributes: {} } },
    "PATCH /v1/appStoreReviewDetails/rd-1": { data: {} } }, `@appstoreconnect:set_review_contact:${BUNDLE} 1.0.0 {"notes":"Use the demo space."}`);
  assert.deepEqual(writes(patched.calls), ["PATCH /v1/appStoreReviewDetails/rd-1"]);
  /* Apple may echo a submitted value in its error; only its code reaches the receipt. */
  const refused = await execute("set_review_contact", { app: BUNDLE, platform: "IOS", version: "1.0.0", contact: '{"contactPhone":"+1 555 0100"}' },
    { ...open, "POST /v1/appStoreReviewDetails": { status: 409, errors: [{ code: "ENTITY_ERROR.ATTRIBUTE.INVALID", detail: "The phone number +1 555 0100 is invalid." }] } })
    .catch((error) => error);
  assert.match(refused.message, /returned 409: ENTITY_ERROR\.ATTRIBUTE\.INVALID$/u);
});
