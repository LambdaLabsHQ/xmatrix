// Loaded with --import into every Hub test process (packages/hub/test/run-suite.mjs).
// Node has no cloudflare:* modules. Worker sources import them, and tests import
// those sources statically, so the redirect must exist before any test module
// evaluates: every cloudflare:* specifier resolves to a stub whose platform
// classes throw if an injected test port ever constructs them.
import { register } from "node:module";

register(new URL("./platform-preload-hooks.mjs", import.meta.url));
