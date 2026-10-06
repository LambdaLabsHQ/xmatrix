const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");
const vm = require("node:vm");
const { installTypeScriptRequire } = require("../../components/dashboard/typescript-require.cjs");
installTypeScriptRequire();

const filename = `${__dirname}/message-attachment-upload-proxy.ts`;
const source = fs.readFileSync(filename, "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: filename,
}).outputText;

let fetchCall;
const moduleValue = { exports: {} };
vm.runInNewContext(js, {
  module: moduleValue,
  exports: moduleValue.exports,
  AbortController,
  Request,
  Response,
  clearTimeout,
  setTimeout,
  fetch: async (url, init) => {
    fetchCall = { url, init };
    return Response.json({ ok: true });
  },
  require: (specifier) => {
    if (specifier === "@xmatrix/protocol/relay-v2/message-attachment") {
      return {
        RELAY_V2_BLOB_UPLOAD_CHECKSUM_HEADER: "x-xmatrix-content-sha256",
        RELAY_V2_BLOB_UPLOAD_PREFIX: "/api/relay-v2/private-r2/uploads",
      };
    }
    if (specifier === "@xmatrix/protocol") {
      return { withRoute: (origin, route) => `${origin}${route}` };
    }
    if (specifier === "@/lib/xmatrix") {
      return { getXMatrixHubUrl: () => "https://hub.example" };
    }
    if (specifier === "@/lib/xmatrix-proxy") {
      return { getProxyAuthorization: async () => "Bearer resolved" };
    }
    if (specifier === "@/lib/xmatrix-proxy-failure") {
      return require(`${__dirname}/../xmatrix-proxy-failure.ts`);
    }
    return require(specifier);
  },
});

const { proxyMessageAttachmentUpload } = moduleValue.exports;

test("the Web proxy preserves the scoped attachment authority route", async () => {
  fetchCall = undefined;
  const request = new Request("https://app.example/upload", {
    method: "PUT",
    headers: {
      authorization: "Bearer browser",
      "content-type": "image/png",
      "x-xmatrix-content-sha256": "a".repeat(64),
    },
    body: new Uint8Array([1, 2, 3]),
    duplex: "half",
  });

  const response = await proxyMessageAttachmentUpload({
    request,
    intentId: "intent/1",
    visibilityScopeId: "space:space-1",
  });

  assert.equal(response.status, 200);
  assert.equal(
    fetchCall.url,
    "https://hub.example/api/relay-v2/private-r2/uploads/intent%2F1/scope/space%3Aspace-1",
  );
  assert.equal(fetchCall.init.headers.authorization, "Bearer resolved");
  assert.equal(fetchCall.init.headers["content-type"], "image/png");
  assert.equal(fetchCall.init.headers["x-xmatrix-content-sha256"], "a".repeat(64));
});
