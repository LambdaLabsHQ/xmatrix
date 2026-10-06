import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const desktopDir = path.join(rootDir, "apps/desktop");
const requireFromBuilder = createRequire(realpathSync(path.join(rootDir, "node_modules/electron-builder/package.json")));

function findModule(nodes, name) {
  for (const node of nodes ?? []) {
    if (node.name === name) return node;
    const nested = findModule(node.dependencies, name);
    if (nested) return nested;
  }
  return undefined;
}

test("desktop packaging collector resolves builder-util-runtime 9.7.0", async () => {
  const { TraversalNodeModulesCollector } = requireFromBuilder(
    "app-builder-lib/out/node-module-collector/traversalNodeModulesCollector.js",
  );
  const { nodeModules } = await new TraversalNodeModulesCollector(desktopDir).getNodeModules({
    packageName: "@xmatrix/desktop",
  });
  const runtime = findModule(nodeModules, "builder-util-runtime");
  assert.ok(runtime, "builder-util-runtime was not collected");
  assert.equal(runtime.version, "9.7.0");
  assert.equal(JSON.parse(readFileSync(path.join(runtime.dir, "package.json"), "utf8")).version, "9.7.0");
});
