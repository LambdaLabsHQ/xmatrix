const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const {
  findDesktopReleaseAssetByAlias,
  fetchPublishedReleaseNotes,
  getLatestReleaseManifest,
  hasCompleteDesktopMacReleaseAssets,
  hasCompleteDesktopWindowsReleaseAssets,
  parseReleaseAssetRange,
  releaseFromR2ChannelPointer,
  selectLatestPublishedGitHubReleaseByTagPrefix,
} = require("./github-release.ts");

test("update manifests link to the component's release rather than the Web build", () => {
  const manifest = getLatestReleaseManifest({ tag_name: "cli-v1.1.1-beta.4", assets: [] }, "https://xmatrix.sh", "/api/cli/releases/dev");
  assert.equal(manifest.releaseNotesUrl, "https://xmatrix.sh/releases/1.1.1-beta.4");
});

test("public notes resolve an exact published tag, excluding drafts, receipts and mismatches", async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const notes = "<!-- xmatrix-release-notes:v1 -->\nImproved updates.\n\n## Deployment receipt\n\nEvidence.";
  let payload = { tag_name: "xmatrix-v1.2.0", body: notes };
  global.fetch = async (url) => {
    assert.match(url, /\/releases\/tags\/xmatrix-v1\.2\.0$/u);
    return Response.json(payload);
  };
  assert.equal(await fetchPublishedReleaseNotes("1.2.0"), "Improved updates.");
  payload = { ...payload, draft: true };
  assert.equal(await fetchPublishedReleaseNotes("1.2.0"), undefined);
  payload = { tag_name: "xmatrix-v1.2.1", body: notes };
  assert.equal(await fetchPublishedReleaseNotes("1.2.0"), undefined);
  payload = { tag_name: "xmatrix-v1.2.0", body: "Production receipt" };
  assert.equal(await fetchPublishedReleaseNotes("1.2.0"), undefined);
  global.fetch = async () => new Response(null, { status: 404 });
  assert.equal(await fetchPublishedReleaseNotes("1.2.0"), undefined);
  global.fetch = async (url) => {
    if (url.endsWith("/releases/tags/xmatrix-v1.2.0")) return new Response(null, { status: 404 });
    assert.match(url, /\/contents\/docs\/releases\/1\.2\.0\.md\?ref=xmatrix-v1\.2\.0$/u);
    return new Response("# xMatrix 1.2.0\n\nRead these notes before the final receipt.");
  };
  assert.equal(await fetchPublishedReleaseNotes("1.2.0"), "Read these notes before the final receipt.");
  global.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(fetchPublishedReleaseNotes("1.2.0"), /503/u);
});

function release(tagName, options = {}) {
  return {
    tag_name: tagName,
    draft: options.draft || false,
    prerelease: options.prerelease || false,
    assets: options.assets || [],
  };
}

function asset(name) {
  return {
    name,
    url: `https://example.com/${name}`,
    size: 1,
    content_type: "application/octet-stream",
  };
}

function desktopAssets(version) {
  return desktopMacAssets(version);
}

function desktopMacAssets(version) {
  return [
    "latest-mac.yml",
    `xMatrix-${version}-arm64.dmg`,
    `xMatrix-${version}-arm64.zip`,
    `xMatrix-${version}-arm64.dmg.blockmap`,
    `xMatrix-${version}-arm64.zip.blockmap`,
  ].map(asset);
}

function desktopWindowsAssets(version) {
  return [`xMatrix-${version}-x64.exe`, `xMatrix-${version}-x64.exe.blockmap`, "latest.yml"].map(asset);
}

test("selectLatestPublishedGitHubReleaseByTagPrefix uses semver order instead of release list order", () => {
  const selected = selectLatestPublishedGitHubReleaseByTagPrefix(
    [
      release("desktop-v0.11.9", { assets: desktopAssets("0.11.9") }),
      release("desktop-v0.11.10", { assets: desktopAssets("0.11.10") }),
      release("desktop-v0.11.11", {
        draft: true,
        assets: desktopAssets("0.11.11"),
      }),
      release("desktop-v0.11.12", {
        prerelease: true,
        assets: desktopAssets("0.11.12"),
      }),
    ],
    "desktop-v"
  );

  assert.equal(selected?.tag_name, "desktop-v0.11.10");
});

test("selectLatestPublishedGitHubReleaseByTagPrefix applies target asset eligibility before choosing latest", () => {
  const selected = selectLatestPublishedGitHubReleaseByTagPrefix(
    [
      release("desktop-v0.11.10", {
        assets: desktopAssets("0.11.10").slice(1),
      }),
      release("desktop-v0.11.9", { assets: desktopAssets("0.11.9") }),
    ],
    "desktop-v",
    (candidate) => candidate.assets.some((candidateAsset) => candidateAsset.name === "latest-mac.yml")
  );

  assert.equal(selected?.tag_name, "desktop-v0.11.9");
});

test("desktop macOS aliases resolve each architecture's own build", () => {
  const armOnly = release("desktop-v0.11.10", {
    assets: desktopMacAssets("0.11.10"),
  });
  assert.equal(hasCompleteDesktopMacReleaseAssets(armOnly), true);
  assert.equal(findDesktopReleaseAssetByAlias(armOnly, "latest-arm64.dmg")?.name, "xMatrix-0.11.10-arm64.dmg");
  assert.equal(findDesktopReleaseAssetByAlias(armOnly, "latest-x64.dmg"), undefined);

  const both = release("desktop-v0.11.11", {
    assets: [
      ...desktopMacAssets("0.11.11"),
      ...[`xMatrix-0.11.11-x64.dmg`, `xMatrix-0.11.11-x64.zip`, `xMatrix-0.11.11-x64.exe`].map(asset),
    ],
  });
  assert.equal(findDesktopReleaseAssetByAlias(both, "latest-x64.dmg")?.name, "xMatrix-0.11.11-x64.dmg");
  assert.equal(findDesktopReleaseAssetByAlias(both, "latest-x64.zip")?.name, "xMatrix-0.11.11-x64.zip");
  assert.equal(findDesktopReleaseAssetByAlias(both, "latest-arm64.zip")?.name, "xMatrix-0.11.11-arm64.zip");
});

test("desktop mac release eligibility accepts published releases without Windows assets", () => {
  const macOnlyRelease = release("desktop-v0.11.18", {
    assets: desktopMacAssets("0.11.18"),
  });

  assert.equal(hasCompleteDesktopMacReleaseAssets(macOnlyRelease), true);
  assert.equal(hasCompleteDesktopWindowsReleaseAssets(macOnlyRelease), false);
});

test("desktop platform release eligibility is applied per platform before selecting latest", () => {
  const macOnlyLatest = release("desktop-v0.11.18", {
    assets: desktopMacAssets("0.11.18"),
  });
  const olderFullWindows = release("desktop-v0.11.17", {
    assets: [...desktopMacAssets("0.11.17"), ...desktopWindowsAssets("0.11.17")],
  });

  assert.equal(
    selectLatestPublishedGitHubReleaseByTagPrefix(
      [macOnlyLatest, olderFullWindows],
      "desktop-v",
      hasCompleteDesktopMacReleaseAssets
    )?.tag_name,
    "desktop-v0.11.18"
  );
  assert.equal(
    selectLatestPublishedGitHubReleaseByTagPrefix(
      [macOnlyLatest, olderFullWindows],
      "desktop-v",
      hasCompleteDesktopWindowsReleaseAssets
    )?.tag_name,
    "desktop-v0.11.17"
  );
});

test("R2 channel pointers resolve immutable release assets without GitHub upload URLs", () => {
  const selected = releaseFromR2ChannelPointer(
    {
      schemaVersion: 1,
      component: "cli",
      channel: "stable",
      releaseTag: "cli-v0.17.0",
      prefix: "releases/cli-v0.17.0",
      files: [
        {
          name: "xmatrix-linux-x64",
          key: "releases/cli-v0.17.0/xmatrix-linux-x64",
          size: 42,
          contentType: "application/octet-stream",
          sha256: "a".repeat(64),
        },
      ],
    },
    "cli"
  );

  assert.equal(selected.tag_name, "cli-v0.17.0");
  assert.equal(selected.assets[0].r2Key, "releases/cli-v0.17.0/xmatrix-linux-x64");
  assert.equal(selected.assets[0].url, "");
});

test("R2 channel pointers accept files a build machine uploaded as a release part", () => {
  const selected = releaseFromR2ChannelPointer(
    {
      schemaVersion: 1,
      component: "desktop",
      channel: "stable",
      releaseTag: "desktop-v0.17.0",
      prefix: "releases/desktop-v0.17.0",
      files: [
        {
          name: "latest-mac.yml",
          key: "releases/desktop-v0.17.0/parts/macos/37296580506-2/latest-mac.yml",
          size: 42,
          sha256: "c".repeat(64),
        },
      ],
    },
    "desktop"
  );
  assert.equal(selected.assets[0].r2Key, "releases/desktop-v0.17.0/parts/macos/37296580506-2/latest-mac.yml");
  for (const key of [
    "releases/desktop-v0.17.0/parts/macos/latest-mac.yml",
    "releases/desktop-v0.17.0/parts/../37296580506-2/latest-mac.yml",
    "releases/desktop-v0.17.0/other/macos/1-1/latest-mac.yml",
  ]) {
    assert.throws(() =>
      releaseFromR2ChannelPointer(
        {
          schemaVersion: 1,
          component: "desktop",
          channel: "stable",
          releaseTag: "desktop-v0.17.0",
          prefix: "releases/desktop-v0.17.0",
          files: [{ name: "latest-mac.yml", key, size: 42, sha256: "c".repeat(64) }],
        },
        "desktop"
      )
    );
  }
});

test("R2 channel pointers resolve only for the channel they were published to", () => {
  const pointer = {
    schemaVersion: 1,
    component: "cli",
    channel: "dev",
    releaseTag: "cli-v0.17.0",
    prefix: "releases/cli-v0.17.0",
    files: [
      {
        name: "xmatrix-linux-x64",
        key: "releases/cli-v0.17.0/parts/linux-x64/1-1/xmatrix-linux-x64",
        size: 42,
        sha256: "d".repeat(64),
      },
    ],
  };
  assert.equal(releaseFromR2ChannelPointer(pointer, "cli", "dev").tag_name, "cli-v0.17.0");
  assert.throws(() => releaseFromR2ChannelPointer(pointer, "cli"), /cli stable channel pointer/u);
  assert.throws(() => releaseFromR2ChannelPointer({ ...pointer, channel: "stable" }, "cli", "dev"));
});

test("R2 channel pointers reject key substitution outside the immutable prefix", () => {
  assert.throws(() =>
    releaseFromR2ChannelPointer(
      {
        schemaVersion: 1,
        component: "android",
        channel: "stable",
        releaseTag: "android-v0.17.0",
        prefix: "releases/android-v0.17.0",
        files: [
          {
            name: "latest.apk",
            key: "releases/other/latest.apk",
            size: 42,
            contentType: "application/vnd.android.package-archive",
            sha256: "b".repeat(64),
          },
        ],
      },
      "android"
    )
  );
});

test("release asset ranges support Electron updater byte requests", () => {
  assert.deepEqual(parseReleaseAssetRange("bytes=0-1023", 10_000), { offset: 0, length: 1024 });
  assert.deepEqual(parseReleaseAssetRange("bytes=9000-", 10_000), { offset: 9000, length: 1000 });
  assert.deepEqual(parseReleaseAssetRange("bytes=-500", 10_000), { offset: 9500, length: 500 });
  assert.deepEqual(parseReleaseAssetRange("bytes=9500-12000", 10_000), { offset: 9500, length: 500 });
  assert.equal(parseReleaseAssetRange(null, 10_000), undefined);
});

test("release asset ranges reject multipart and unsatisfiable requests", () => {
  assert.throws(() => parseReleaseAssetRange("bytes=0-1,4-5", 10_000));
  assert.throws(() => parseReleaseAssetRange("bytes=10000-", 10_000));
  assert.throws(() => parseReleaseAssetRange("bytes=-0", 10_000));
});

test("a channel pointer is read by its version: stable refuses a beta, dev may name either", () => {
  const pointer = (channel, releaseTag) => ({
    schemaVersion: 1,
    component: "cli",
    channel,
    releaseTag,
    prefix: `releases/${releaseTag}`,
    files: [{ name: "xmatrix-linux-x64", key: `releases/${releaseTag}/xmatrix-linux-x64`, size: 42, sha256: "a".repeat(64) }],
  });
  assert.throws(() => releaseFromR2ChannelPointer(pointer("stable", "cli-v1.0.606-beta.3"), "cli", "stable"),
    /stable channel names beta cli-v1\.0\.606-beta\.3/u);
  assert.equal(releaseFromR2ChannelPointer(pointer("dev", "cli-v1.0.606-beta.3"), "cli", "dev").prerelease, true);
  // A dev pointer from before betas had their own versions still resolves.
  assert.equal(releaseFromR2ChannelPointer(pointer("dev", "cli-v1.0.602"), "cli", "dev").prerelease, false);
  assert.equal(releaseFromR2ChannelPointer(pointer("stable", "cli-v1.1.0"), "cli", "stable").prerelease, false);
  assert.throws(() => releaseFromR2ChannelPointer(pointer("stable", "cli-vlatest"), "cli", "stable"), /Invalid R2 cli stable/u);
});

test("the stable GitHub fallback never picks a beta, even one published without the prerelease flag", () => {
  const selected = selectLatestPublishedGitHubReleaseByTagPrefix(
    [release("cli-v1.0.606-beta.3"), release("cli-v1.0.605"), release("cli-v1.0.606-beta.2", { prerelease: true })],
    "cli-v"
  );
  assert.equal(selected.tag_name, "cli-v1.0.605");
});
