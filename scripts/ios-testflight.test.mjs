import { assert, fs, os, path, spawnSync, test, rootDir } from "./script-test-fixture.mjs";

// Apple's version drops a beta's `-beta.N`, so the archive is the only place an
// iOS build learns its channel: the Web it loads is set there. Run the real
// release script against a stand-in Xcode and read what it archived.
function archive(t, version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xmatrix-ios-testflight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(path.join(rootDir, "scripts/ios-testflight.sh"), path.join(root, "scripts/ios-testflight.sh"));
  fs.writeFileSync(path.join(root, "version.json"), JSON.stringify({ version }));
  const xcode = path.join(root, "xcode");
  fs.mkdirSync(path.join(xcode, "usr/bin"), { recursive: true });
  // The script clears its environment, so the stand-in logs beside itself.
  fs.writeFileSync(path.join(xcode, "usr/bin/xcodebuild"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$(dirname "$0")/../../xcodebuild.log"\n', { mode: 0o755 });
  const result = spawnSync("bash", [path.join(root, "scripts/ios-testflight.sh")], {
    encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, XCODE_DEVELOPER_DIR: xcode, IOS_DEVELOPMENT_TEAM: "ABCDE12345",
      IOS_BUILD_NUMBER: "42", SKIP_TESTFLIGHT_UPLOAD: "1" },
  });
  const log = path.join(xcode, "xcodebuild.log");
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  return { ...result, calls };
}

test("a TestFlight archive loads the Web of the channel its release version names", (t) => {
  for (const [version, web] of [["1.4.0-beta.12", "https://beta.xmatrix.sh/app"], ["1.4.0", "https://xmatrix.sh/app"]]) {
    const { status, stderr, calls } = archive(t, version);
    assert.equal(status, 0, stderr);
    assert.equal(calls.length, 2, version);
    const archived = calls[0].split(" ");
    assert.equal(archived.at(-1), "archive");
    assert.ok(archived.includes(`XMATRIX_WEB_URL=${web}`), `${version}: ${calls[0]}`);
    assert.ok(archived.includes("MARKETING_VERSION=1.4.0"), `${version}: ${calls[0]}`);
  }
});

test("a version that names no release channel archives nothing", (t) => {
  for (const version of ["1.4.0-rc.1", "1.4.0-beta.0", "1.4", ""]) {
    const { status, stderr, calls } = archive(t, version);
    assert.equal(status, 2, version);
    assert.match(stderr, /neither a stable X\.Y\.Z nor a beta X\.Y\.Z-beta\.N/u);
    assert.deepEqual(calls, [], version);
  }
});
