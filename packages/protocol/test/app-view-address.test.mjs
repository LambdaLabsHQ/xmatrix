import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_VIEW_SELECTION_FIELDS, appViewAddress, appViewSelectionField, appViewSelectionQuery, isAppSelectionView,
} from "../dist/index.js";

test("each view names its selection with its own field", () => {
  assert.equal(appViewSelectionQuery("settings", "billing").toString(), "section=billing");
  assert.equal(appViewSelectionQuery("agents", "codex", { edit: "profile" }).toString(), "agent=codex&edit=profile");
  assert.equal(appViewSelectionField("pages"), null);
  assert.equal(isAppSelectionView("toString"), false);
  for (const [view, field] of Object.entries(APP_VIEW_SELECTION_FIELDS)) {
    assert.equal(appViewSelectionField(view), field);
    assert.notEqual(field, "item");
  }
});

test("a forwarded query keeps its fields after the selection, which it cannot override", () => {
  const forwarded = new URLSearchParams("section=account&checkout=success&checkout_session_id=cs_1");
  assert.equal(appViewSelectionQuery("settings", "billing", {}, forwarded).toString(),
    "section=billing&checkout=success&checkout_session_id=cs_1");
});

test("an address outside the shell encodes the Space and the selection", () => {
  assert.equal(appViewAddress("space a", "apps", "gmail", { gmailWatch: "failed" }),
    "/app/space%20a/apps?connector=gmail&gmailWatch=failed");
});
