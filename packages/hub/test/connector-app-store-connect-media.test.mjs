import assert from "node:assert/strict";
import { test } from "node:test";

import { ACTIONS, apps, BUNDLE, credentials, run, statement, version, versions, withApple, writes } from "./support/app-store-connect-double.mjs";

const GROUP = "IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE";
const draft = { ...apps, ...versions(version("v1", "1.0.0", "PREPARE_FOR_SUBMISSION")),
  "GET /v1/appStoreVersions/v1/appStoreVersionLocalizations": { data: [{ type: "appStoreVersionLocalizations", id: "loc-en", attributes: { locale: "en-US" } }] } };
const placement = (id, image, group = GROUP) => ({ type: "appAssetLibraryPlacements", id, attributes: { placementType: "APP_SCREENSHOT", placementGroup: group,
  state: "PARENT_PREPARE_FOR_SUBMISSION" }, relationships: { image: { data: { type: "appAssetLibraryImages", id: image } } } });
const placed = (...rows) => ({ "GET /v1/appStoreVersionLocalizations/loc-en/placements": { data: rows,
  included: rows.map((row) => ({ type: "appAssetLibraryImages", id: row.relationships.image.data.id, attributes: { fileName: `${row.relationships.image.data.id}.png` } })) } });

test("screenshot_specs reads the groups and exact sizes from Apple's reference data", async () => {
  const catalog = { data: [{ type: "appAssetLibraryRefData", id: "ref", attributes: {
    features: [{ featureId: "APP_STORE_VERSIONS", placementPolicies: [{ placementType: "APP_SCREENSHOT", groupLimits: [{ groupIds: [GROUP, "IPAD_13_PROFILE"], maxCount: 10 }] }] }],
    placementProfileGroups: [{ placementProfileGroupId: GROUP, platform: "IPHONE_APP_STORE", displayClassId: "IPHONE_DYNAMIC_ISLAND_LARGE_DISPLAY" },
      { placementProfileGroupId: "IPAD_13_PROFILE", platform: "IPAD_APP_STORE", displayClassId: "IPAD_13_DISPLAY" },
      { placementProfileGroupId: "EVENT_ONLY_PROFILE", platform: "ANY", displayClassId: "DEFAULT" }],
    imageSpecs: [{ specId: "s1", dimensions: { minWidth: 1290, maxWidth: 1290, minHeight: 2796, maxHeight: 2796 } },
      { specId: "s2", dimensions: { minWidth: 2796, maxWidth: 2796, minHeight: 1290, maxHeight: 1290 } },
      { specId: "s3", dimensions: { minWidth: 2064, maxWidth: 2064, minHeight: 2752, maxHeight: 2752 } }],
    placementTypes: [{ placementTypeId: "APP_SCREENSHOT", specMappings: [{ placementGroupId: GROUP, specs: ["s1", "s2"] }, { placementGroupId: "IPAD_13_PROFILE", specs: ["s3"] }] }],
  } }] };
  const all = await run({ "GET /v1/appAssetLibraryRefData": catalog }, "@appstoreconnect:screenshot_specs:*");
  assert.equal(all.calls[0].query["filter[placementTypes]"], "APP_SCREENSHOT");
  assert.match(all.value.summary, new RegExp(`${GROUP}\\tIPHONE_APP_STORE\\tIPHONE_DYNAMIC_ISLAND_LARGE_DISPLAY\\t10\\t1290x2796 2796x1290\\nIPAD_13_PROFILE\\tIPAD_APP_STORE\\tIPAD_13_DISPLAY\\t10\\t2064x2752`, "u"));
  assert.doesNotMatch(all.value.summary, /EVENT_ONLY_PROFILE/u, "a group that takes no screenshots is not listed");
  const ipad = await run({ "GET /v1/appAssetLibraryRefData": catalog }, "@appstoreconnect:screenshot_specs:* ipad");
  assert.doesNotMatch(ipad.value.summary, new RegExp(GROUP, "u"));
  assert.equal(typeof statement("@appstoreconnect:screenshot_specs:* android"), "string");
});

test("upload_screenshot reserves an image in the app's library and lists its parts", async () => {
  assert.deepEqual(statement(`@appstoreconnect:upload_screenshot:${BUNDLE} home 6.9.png 14619`), { app: BUNDLE, fileName: "home 6.9.png", fileSize: "14619" });
  for (const bad of [`upload_screenshot:${BUNDLE} home.gif 100`, `upload_screenshot:${BUNDLE} home.png`, `upload_screenshot:${BUNDLE} home.png 0`]) {
    assert.equal(typeof statement(`@appstoreconnect:${bad}`), "string", bad);
  }
  const reserved = await run({ ...apps, "GET /v1/apps/6760000001/assetLibrary": { data: { type: "appAssetLibraries", id: "lib-1" } },
    "POST /v1/appAssetLibraryImages": { data: { type: "appAssetLibraryImages", id: "img-1", attributes: { state: "AWAITING_UPLOAD", uploadOperations: [
      { method: "PUT", url: "https://store-030.blobstore.apple.com/a?Signature=x", offset: 0, length: 14619, requestHeaders: [{ name: "Content-Type", value: "image/png" }] }] } } } },
  `@appstoreconnect:upload_screenshot:${BUNDLE} home.png 14619`);
  assert.deepEqual(reserved.calls.at(-1).body, { type: "appAssetLibraryImages", attributes: { category: "APP_SCREENSHOTS_AND_PREVIEWS", fileName: "home.png", fileSize: 14619 },
    relationships: { assetLibrary: { data: { type: "appAssetLibraries", id: "lib-1" } } } });
  assert.match(reserved.value.summary, /Reserved image img-1 .* then run @appstoreconnect:commit_upload:img-1 image/u);

  /* The library commit takes `uploaded` alone, and its state is the asset's own. */
  const committed = await run({ "GET /v1/appAssetLibraryImages/img-1": { data: { type: "appAssetLibraryImages", id: "img-1", attributes: { state: "AWAITING_UPLOAD" } } },
    "PATCH /v1/appAssetLibraryImages/img-1": { data: { type: "appAssetLibraryImages", id: "img-1", attributes: { state: "UPLOAD_COMPLETE" } } } },
  "@appstoreconnect:commit_upload:img-1 image");
  assert.deepEqual(committed.calls.at(-1).body, { type: "appAssetLibraryImages", id: "img-1", attributes: { uploaded: true } });
  assert.match(committed.value.summary, /Apple reports UPLOAD_COMPLETE\. .* place it with set_screenshots/u);
  const failed = await run({ "GET /v1/appAssetLibraryImages/img-1": { data: { type: "appAssetLibraryImages", id: "img-1", attributes: { state: "FAILED",
    stateDetails: [{ code: "IMAGE_INCORRECT_DIMENSIONS", description: "The dimensions match no specification." }] } } } }, "@appstoreconnect:read_upload:img-1 image");
  assert.match(failed.value.summary, /FAILED\n {2}info IMAGE_INCORRECT_DIMENSIONS: The dimensions match no specification\./u);
});

test("set_screenshots makes a group show exactly the named images in order", async () => {
  const set = (images) => `@appstoreconnect:set_screenshots:${BUNDLE} 1.0.0 ${JSON.stringify({ locale: "en-US", group: GROUP, images })}`;
  assert.deepEqual(statement(set(["a", "b"])), { app: BUNDLE, platform: "IOS", version: "1.0.0", locale: "en-US", group: GROUP, images: '["a","b"]' });
  for (const bad of [set(["a", "a"]), set(Array.from({ length: 11 }, (_, index) => `i${index}`)), set(["has space"]), set("a"),
    `@appstoreconnect:set_screenshots:${BUNDLE} 1.0.0 {"locale":"en-US","group":"lower","images":[]}`,
    `@appstoreconnect:set_screenshots:${BUNDLE} 1.0.0 {"group":"${GROUP}","images":[]}`,
    `@appstoreconnect:set_screenshots:${BUNDLE} 1.0.0 {"locale":"en-US","group":"${GROUP}","images":[],"placementType":"APP_PREVIEW"}`]) {
    assert.equal(typeof statement(bad), "string", bad);
  }
  const changed = await run({ ...draft, ...placed(placement("p-old", "old"), placement("p-keep", "keep")), "DELETE /v1/appAssetLibraryPlacements/p-old": null,
    "POST /v1/appAssetLibraryPlacements": { data: placement("p-new", "new") }, "POST /v1/appAssetLibraryPlacementOrderingRequests": { data: {} } }, set(["new", "keep"]));
  assert.equal(changed.calls.find((call) => call.path.endsWith("/placements")).query["filter[placementGroup]"], GROUP);
  assert.deepEqual(writes(changed.calls), ["DELETE /v1/appAssetLibraryPlacements/p-old", "POST /v1/appAssetLibraryPlacements", "POST /v1/appAssetLibraryPlacementOrderingRequests"],
    "the old placement goes first, so a full group has room");
  const [create, order] = changed.calls.filter((call) => call.method === "POST").map((call) => call.body);
  assert.deepEqual(create, { type: "appAssetLibraryPlacements", attributes: { placementType: "APP_SCREENSHOT", placementGroup: GROUP }, relationships: {
    image: { data: { type: "appAssetLibraryImages", id: "new" } }, appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: "loc-en" } } } });
  assert.deepEqual(order.relationships.orderedPlacements.data.map((item) => item.id), ["p-new", "p-keep"]);
  assert.equal(order.attributes.placementGroup, GROUP);
  assert.match(changed.value.summary, /now shows 2 screenshot\(s\) in the given order: 1 placed, 1 removed, 1 kept/u);

  const same = await run({ ...draft, ...placed(placement("p-keep", "keep")) }, set(["keep"]));
  assert.deepEqual(writes(same.calls), [], "repeating the statement changes nothing");
  const missing = await withApple({ ...apps, ...versions(version("v1", "1.0.0", "PREPARE_FOR_SUBMISSION")),
    "GET /v1/appStoreVersions/v1/appStoreVersionLocalizations": { data: [] } },
  () => assert.rejects(ACTIONS.set_screenshots.execute({ credentials }, { app: BUNDLE, platform: "IOS", version: "1.0.0", locale: "ja", group: GROUP, images: "[]" }), /no ja listing; create it with set_metadata first/u));
  assert.deepEqual(writes(missing.calls), []);
});

test("screenshots lists each language's groups in display order", async () => {
  const listed = await run({ ...draft, ...placed(placement("p1", "img-a"), placement("p2", "img-b"), placement("p3", "img-c", "IPAD_13_PROFILE")) },
    `@appstoreconnect:screenshots:${BUNDLE} 1.0.0`);
  assert.equal(listed.calls.at(-1).query.sort, "placementGroupPosition");
  assert.match(listed.value.summary, new RegExp(`en-US: \\n {2}${GROUP}\\n {4}1\\timage img-a\\timg-a\\.png\\tPARENT_PREPARE_FOR_SUBMISSION\\n {4}2\\timage img-b\\timg-b\\.png\\t[A-Z_]+\\n {2}IPAD_13_PROFILE\\n {4}1\\timage img-c`, "u"));
  assert.deepEqual(writes(listed.calls), []);
});
