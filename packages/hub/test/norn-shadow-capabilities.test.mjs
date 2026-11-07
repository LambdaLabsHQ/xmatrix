import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

// A capability/architecture contract: bundle the actual production evaluator
// with a linker that cannot load transport, credentials or database modules.
// PostgreSQL ACL tests separately deny mutation of real source-domain tables.
test("candidate programs have no action transport or ambient Node capabilities",async () => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve("wrangler/package.json"))("esbuild");
  const entry = fileURLToPath(new URL("../src/norn-shadow-evaluator.ts",import.meta.url));
  const vendor = fileURLToPath(new URL("../src/vendor/norn/",import.meta.url));
  const bundled = await build({ entryPoints: [entry],bundle: true,write: false,platform: "neutral",format: "cjs",
    plugins: [{ name: "pure-evaluator-capabilities",setup(builder) {
      builder.onResolve({ filter: /.*/ },args => {
        if (args.kind === "entry-point") return null;
        assert.ok(args.path.startsWith("."),`unexpected capability import: ${args.path}`);
        assert.ok(resolve(args.resolveDir,args.path).startsWith(vendor),`outside the pure evaluator: ${args.path}`);
        return null;
      });
    } }] });
  const sandboxModule = { exports: {} };
  const unavailable = () => { throw new Error("candidate attempted external I/O"); };
  vm.runInNewContext(bundled.outputFiles[0].text,{ module: sandboxModule,exports: sandboxModule.exports,TextEncoder,structuredClone,
    fetch: unavailable,WebSocket: unavailable,require: unavailable },{ timeout: 1000 });
  const evaluator = sandboxModule.exports.nornShadowEvaluator;
  const { programs } = JSON.parse(readFileSync(new URL("./fixtures/norn-shadow-programs.json",import.meta.url),"utf8"));
  for (const name of ["run","message","judge"]) {
    const ast = programs[name].ast,initial = evaluator.create(ast,0);
    const result = evaluator.advance(ast,initial.snapshot,
      { bindingId: "binding",participant: "@codex:2",sourceRef: "execution:binding" },null,0);
    assert.ok(["waiting","ready","incomplete"].includes(result.state));
  }
});
