import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredHubConnectSources,
  configuredHubOrigin,
} from "./next-config-environment.mjs";

test("CSP Hub sources follow the exact environment-specific origin", () => {
  const testOrigin = configuredHubOrigin({
    NEXT_PUBLIC_AUTH_BASE_URL: "https://xmatrix-hub.test.xmatrix.sh",
  });
  assert.equal(testOrigin, "https://xmatrix-hub.test.xmatrix.sh");
  assert.deepEqual(configuredHubConnectSources(testOrigin), [
    "https://xmatrix-hub.test.xmatrix.sh",
    "wss://xmatrix-hub.test.xmatrix.sh",
  ]);
  assert.doesNotMatch(configuredHubConnectSources(testOrigin).join(" "), /xmatrix-hub\.xmatrix\.sh/u);
});

test("production remains the default when no Hub origin is configured", () => {
  assert.equal(configuredHubOrigin({}), "https://xmatrix-hub.xmatrix.sh");
});

test("CSP rejects non-origin and non-HTTP Hub values", () => {
  for (const value of [
    "https://xmatrix-hub.test.xmatrix.sh/path",
    "https://user@xmatrix-hub.test.xmatrix.sh",
    "javascript:alert(1)",
    "not-a-url",
  ]) {
    assert.throws(
      () => configuredHubOrigin({ NEXT_PUBLIC_XMATRIX_HUB_URL: value }),
      /absolute HTTP\(S\) origin/u,
    );
  }
});
