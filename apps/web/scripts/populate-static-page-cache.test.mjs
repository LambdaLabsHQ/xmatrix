import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { populateStaticPageCache } from "./populate-static-page-cache.mjs";

async function openNextBuild(pages) {
  const dir = await mkdtemp(`${tmpdir()}/xmatrix-open-next-`);
  await mkdir(`${dir}/assets/cdn-cgi/_next_cache/old-build`, { recursive: true });
  await writeFile(`${dir}/assets/cdn-cgi/_next_cache/old-build/workspace.cache`, "old");
  await writeFile(`${dir}/assets/BUILD_ID`, "build-1\n");
  await mkdir(`${dir}/cache/build-1`, { recursive: true });
  for (const page of pages) await writeFile(`${dir}/cache/build-1/${page}.cache`, `{"page":"${page}"}`);
  return dir;
}

test("the build's prerendered pages become Worker-only assets under its build id", async () => {
  const dir = await openNextBuild(["workspace", "login"]);
  try {
    assert.equal(populateStaticPageCache(dir).buildId, "build-1");
    assert.equal(await readFile(`${dir}/assets/cdn-cgi/_next_cache/build-1/workspace.cache`, "utf8"), '{"page":"workspace"}');
    assert.equal(await readFile(`${dir}/assets/cdn-cgi/_next_cache/build-1/login.cache`, "utf8"), '{"page":"login"}');
    // Only this build's pages ship: none can name chunks of another build.
    assert.equal(existsSync(`${dir}/assets/cdn-cgi/_next_cache/old-build`), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a build in which the app page is not prerendered fails instead of rendering it per request", async () => {
  const dir = await openNextBuild(["login"]);
  try {
    assert.throws(() => populateStaticPageCache(dir), /did not prerender \/workspace/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
