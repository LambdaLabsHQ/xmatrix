const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  buildSecretCatalogSavePayload,
  normalizeSecretCatalogList,
  secretCatalogFormDraft,
  validateSecretCatalogDraft,
} = require("./secret-catalog.ts");

test("secret catalog validation enforces alias, env name, access, and create value", () => {
  const valid = {
    secretRef: "api-dev-key",
    value: "dev-key",
    envName: "PROVIDER_API_KEY",
    description: "Local experiments",
    access: "auto",
  };

  assert.equal(validateSecretCatalogDraft(valid, "create"), null);
  assert.equal(validateSecretCatalogDraft({ ...valid, secretRef: "  " }, "create"), "Alias is required.");
  assert.equal(
    validateSecretCatalogDraft({ ...valid, envName: "MODEL-API" }, "create"),
    "Env must be a letter or _ followed by up to 119 letters, digits or _."
  );
  // The Hub stores at most 120 characters; the form rejects what the Hub would.
  assert.equal(validateSecretCatalogDraft({ ...valid, envName: `A${"B".repeat(119)}` }, "create"), null);
  assert.equal(
    validateSecretCatalogDraft({ ...valid, envName: `A${"B".repeat(120)}` }, "create"),
    "Env must be a letter or _ followed by up to 119 letters, digits or _."
  );
  assert.equal(validateSecretCatalogDraft({ ...valid, access: "always" }, "create"), "Access must be auto or ask.");
  assert.equal(
    validateSecretCatalogDraft({ ...valid, value: "  " }, "create"),
    "Value is required when creating a secret."
  );
  assert.equal(validateSecretCatalogDraft({ ...valid, value: "" }, "edit"), null);
});

test("secret catalog payload omits an empty value and trims metadata", () => {
  assert.deepEqual(
    buildSecretCatalogSavePayload({
      secretRef: " api-dev-key ",
      value: " dev-key ",
      envName: " PROVIDER_API_KEY ",
      description: " Local experiments ",
      access: "auto",
    }),
    {
      secretRef: "api-dev-key",
      envName: "PROVIDER_API_KEY",
      description: "Local experiments",
      access: "auto",
      value: "dev-key",
    }
  );

  const updatePayload = buildSecretCatalogSavePayload({
    secretRef: "api-dev-key", value: "   ", envName: "", description: "", access: "ask",
  });
  // A cleared description is cleared; the stored value and env name are kept.
  assert.deepEqual(updatePayload, { secretRef: "api-dev-key", description: null, access: "ask" });
  assert.equal(Object.hasOwn(updatePayload, "value"), false);
});

test("secret catalog normalization drops values from list state", () => {
  const list = normalizeSecretCatalogList({
    canManage: true,
    secrets: [
      {
        secretRef: "api-dev-key",
        value: "should-not-survive",
        envName: "PROVIDER_API_KEY",
        description: "Local experiments",
        access: "auto",
        createdByUserId: "user-1",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: "2026-07-08T00:10:00.000Z",
      },
      { secretRef: "fallback-alias", access: "unknown", value: "also-dropped" },
      { secretRef: "  ", value: "ignored" },
    ],
  });

  assert.equal(list.canManage, true);
  assert.equal(list.secrets.length, 2);
  assert.equal(list.secrets[0].secretRef, "api-dev-key");
  assert.equal(Object.hasOwn(list.secrets[0], "value"), false);
  assert.equal(list.secrets[1].secretRef, "fallback-alias");
  assert.equal(list.secrets[1].access, "ask", "an unknown access reads as the stricter one");
  assert.equal(normalizeSecretCatalogList({ secrets: [] }).canManage, false);
});

test("secret catalog edit drafts keep value local and empty by default", () => {
  const draft = secretCatalogFormDraft({
    secretRef: "api-dev-key",
    envName: "PROVIDER_API_KEY",
    description: "Local experiments",
    access: "auto",
    createdByUserId: "user-1",
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:10:00.000Z",
  });

  assert.equal(draft.value, "");
  assert.equal(draft.secretRef, "api-dev-key");
  assert.equal(draft.envName, "PROVIDER_API_KEY");
  assert.equal(draft.access, "auto");
  assert.equal(secretCatalogFormDraft().access, "ask", "a new secret asks first");
});
