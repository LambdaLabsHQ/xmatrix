const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { HUB_ROUTES } = require("@xmatrix/protocol");

/**
 * Load the GET handler of the proxy route in `routeDir` with the Web proxy
 * replaced by `proxy`, so a test sees exactly what the route forwards to Hub.
 * @param {string} routeDir
 * @param {(input: unknown) => Response | Promise<Response>} proxy
 */
function loadProxyRouteGet(routeDir, proxy) {
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(routeDir, "route.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports, URL, URLSearchParams,
    require(name) {
      if (name === "@xmatrix/protocol") return { HUB_ROUTES };
      if (name === "@/lib/xmatrix-proxy") return { proxyXMatrixRequest: proxy };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return exports.GET;
}

module.exports = { loadProxyRouteGet };
