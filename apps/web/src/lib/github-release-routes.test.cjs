const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const Module = require("node:module");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

// R2 is the transport fixture; manifest and download handlers stay real.
const objects = new Map();
function pointer(component, channel, version, files) {
  const prefix = `releases/${component}-v${version}`;
  const entries = files.map(([name, content]) => {
    const key = `${prefix}/${name}`;
    objects.set(key, content);
    return { name, key, size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
  });
  objects.set(`channels/${component}/${channel}.json`, JSON.stringify({
    schemaVersion: 1, component, channel, releaseTag: `${component}-v${version}`, prefix, files: entries,
    commitSha: "a".repeat(40), runId: "123", publishedAt: "2026-11-02T13:00:00Z",
  }));
}
pointer("desktop", "stable", "3.1.0", [["latest-mac.yml", "version: 3.1.0\n"], ["latest.yml", "version: 3.1.0\n"]]);
pointer("desktop", "dev", "3.1.1-beta.1", [["latest-mac.yml", "version: 3.1.1-beta.1\n"], ["latest.yml", "version: 3.1.1-beta.1\n"]]);
pointer("cli", "stable", "3.1.0", [["xmatrix-linux-x64", "cli"]]);
pointer("android", "stable", "1.2.0", [["xmatrix.apk", "android"]]);
const load = Module._load;
Module._load = function (request, ...args) {
  if (request === "@opennextjs/cloudflare") return { getCloudflareContext: () => ({ env: { RELEASE_ASSETS: {
    async get(key) {
      const content = objects.get(key);
      return content === undefined ? null : { body: new Response(content).body, size: Buffer.byteLength(content),
        httpEtag: '"fixture"', writeHttpMetadata(headers) { headers.set("content-type", "application/octet-stream"); } };
    },
  } } }) };
  return load.call(this, request, ...args);
};
const dedicated = require("../app/api/desktop/releases/latest/route.ts");
const aggregate = require("../app/api/releases/latest/route.ts");
const stable = require("../app/api/desktop/releases/stable/[asset]/route.ts");
const legacy = require("../app/api/desktop/releases/[asset]/route.ts");
Module._load = load;

async function download(url) {
  const path = new URL(url).pathname;
  const handler = path.startsWith("/api/desktop/releases/stable/") ? stable : legacy;
  return handler.GET(new Request(url), { params: Promise.resolve({ asset: path.split("/").at(-1) }) });
}

test("stable Desktop manifests link to the exact bytes they advertise, while legacy metadata stays dev", async (t) => {
  for (const [name, handler, path] of [["dedicated", dedicated, "/api/desktop/releases/latest"], ["aggregate", aggregate, "/api/releases/latest"]]) {
    await t.test(name, async () => {
      const response = await handler.GET(new Request(`https://xmatrix.sh${path}`));
      assert.equal(response.status, 200);
      const result = await response.json();
      const manifest = name === "aggregate" ? result.releases.desktop : result;
      assert.equal(manifest.version, "3.1.0");
      for (const asset of manifest.assets) {
        const fetched = await download(asset.browser_download_url);
        assert.equal(fetched.status, 200);
        const bytes = Buffer.from(await fetched.arrayBuffer());
        assert.equal(bytes.toString(), "version: 3.1.0\n");
        assert.equal(bytes.length, asset.size);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
      }
    });
  }
  const oldFeed = await download("https://xmatrix.sh/api/desktop/releases/latest-mac.yml");
  assert.equal(await oldFeed.text(), "version: 3.1.1-beta.1\n");
});
