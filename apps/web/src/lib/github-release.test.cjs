const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const {
  findDesktopReleaseAssetByAlias,
  hasCompleteDesktopMacReleaseAssets,
  hasCompleteDesktopWindowsReleaseAssets,
  parseReleaseAssetRange,
  releaseFromR2ChannelPointer,
  selectLatestPublishedGitHubReleaseByTagPrefix,
} = require("./github-release.ts");

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

test("desktop release assets only expose Apple Silicon macOS downloads", () => {
  const candidate = release("desktop-v0.11.10", {
    assets: desktopMacAssets("0.11.10"),
  });
  assert.equal(hasCompleteDesktopMacReleaseAssets(candidate), true);
  assert.equal(findDesktopReleaseAssetByAlias(candidate, "latest-arm64.dmg")?.name, "xMatrix-0.11.10-arm64.dmg");
  assert.equal(findDesktopReleaseAssetByAlias(candidate, "latest-x64.dmg"), undefined);
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
