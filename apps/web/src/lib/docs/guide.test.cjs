const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { APP_CONNECTOR_PROVIDER_MANIFESTS } = require("@xmatrix/protocol");

const connectors = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "..", "docs", "guide", "connectors.md"), "utf8");

test("the user guide lists every connected app by the id people type", () => {
  for (const { id, name } of APP_CONNECTOR_PROVIDER_MANIFESTS) {
    assert.ok(connectors.includes(`\`${id}\``), `docs/guide/connectors.md has no row for ${name} (\`${id}\`)`);
  }
});
