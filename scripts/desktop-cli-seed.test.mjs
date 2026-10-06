import { assert, fs, path, test, rootDir, readRepoFile } from "./script-test-fixture.mjs";
const read = readRepoFile;

const desktopRelease = read(".github/workflows/desktop-release.yml");
const productionRelease = read(".github/workflows/production-release.yml");
const productionIntent = read(".github/workflows/production-release-intent.yml");
const desktopPackage = JSON.parse(read("apps/desktop/package.json"));
const desktopIgnore = read("apps/desktop/.gitignore");

function job(workflow, name, nextName) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `${name} job is missing`);
  const end = nextName ? workflow.indexOf(`\n  ${nextName}:\n`, start + 1) : workflow.length;
  assert.notEqual(end, -1, `${nextName} job is missing`);
  return workflow.slice(start, end);
}

test("an on-demand Desktop release requires its exact-version CLI seed", () => {
  assert.match(productionIntent, /requested\.includes\("desktop"\) && !requested\.includes\("cli"\)/u);
  assert.match(productionRelease, /selected\.includes\("desktop"\) && !selected\.includes\("cli"\)/u);
  const desktop = job(productionRelease, "desktop", "android");
  assert.match(desktop, /needs: \[preflight, cli\]/u);
  assert.match(desktop, /needs\.cli\.result == 'success'/u);
});

for (const [platform, jobName, nextJob, asset, seed, buildStep] of [
  ["macOS", "release", "windows-release", "xmatrix-macos-arm64", "xmatrix", "name: Build signed macOS app (arm64)"],
  ["Windows", "windows-release", "publish-desktop-release", "xmatrix-windows-x64.exe", "xmatrix.exe", "name: Build Windows installer"],
]) {
  test(`the ${platform} job fetches the exact-version signed CLI seed before it packages`, () => {
    const section = job(desktopRelease, jobName, nextJob);
    const fetchAt = section.indexOf("name: Fetch the signed CLI seed for the App");
    const buildAt = section.indexOf(buildStep);
    assert.ok(fetchAt >= 0, `${platform} job never fetches the seed`);
    assert.ok(buildAt > fetchAt, `${platform} job must fetch the seed before ${buildStep}`);
    const step = section.slice(fetchAt, buildAt);
    assert.match(step, /r2-release-store\.mjs download-directory/u);
    assert.match(step, /--prefix "releases\/cli-v/u);
    assert.ok(step.includes(asset), `${platform} step must copy ${asset}`);
    assert.ok(step.includes(`'${seed}'`) || step.includes(`/${seed}"`), `${platform} step must place the seed as ${seed}`);
    // The seed must prove it is the version this App claims to ship.
    assert.match(step, /--version/u);
    assert.match(step, /DESKTOP_VERSION/u);
  });
}

test("the macOS seed is verified against its code signature", () => {
  const section = job(desktopRelease, "release", "windows-release");
  const step = section.slice(
    section.indexOf("name: Fetch the signed CLI seed for the App"),
    section.indexOf("name: Require macOS release signing identity"),
  );
  assert.match(step, /codesign --verify --strict/u);
});

test("electron-builder packages the seed directory and git never tracks it", () => {
  const seed = desktopPackage.build.extraResources.find((entry) => entry.from === "resources/cli");
  assert.ok(seed, "resources/cli is not an extraResources entry");
  assert.equal(seed.to, "cli");
  assert.deepEqual(seed.filter, ["**/*", "!.gitkeep"]);
  assert.match(desktopIgnore, /^resources\/cli\/\*$/mu);
  assert.match(desktopIgnore, /^!resources\/cli\/\.gitkeep$/mu);
  assert.ok(fs.existsSync(path.join(rootDir, "apps/desktop/resources/cli/.gitkeep")));
});
