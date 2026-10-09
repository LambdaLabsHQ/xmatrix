import { Hono } from "hono";
import { HUB_ROUTES } from "../../../protocol/src/authority-foundation.ts";
import { compileCommonJsSourceModule } from "./commonjs-source-module.mjs";

const load = await compileCommonJsSourceModule(new URL("../../src/index-routes-observability-memory.ts", import.meta.url));

export function createObservabilityMemoryApp(imports) {
  const dependencies = {
    "@xmatrix/protocol": { HUB_ROUTES, utf8ByteLength: (value) => new TextEncoder().encode(value).byteLength },
    "./postgres-authority-http": { postgresAuthorityDatabase: () => ({}) },
    ...imports,
  };
  const app = new Hono();
  load((name) => dependencies[name] ?? {}).registerObservabilityMemoryRoutes(app);
  return app;
}
