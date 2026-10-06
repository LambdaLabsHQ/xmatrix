import { assert, fs, path, test, rootDir, readRepoFile } from "./script-test-fixture.mjs";
const signingPreparation = readRepoFile("scripts/macos-signing-keychain.sh");
const workflow = readRepoFile(".github/workflows/desktop-release.yml");

test("macOS desktop releases use one isolated keychain for the pinned complete chain", () => {
  const chainStep = workflow.indexOf(
    "name: Prepare isolated Developer ID signing keychain",
  );
  const buildStep = workflow.indexOf("name: Build signed macOS app (arm64)");

  assert.notEqual(chainStep, -1);
  assert.match(workflow, /source scripts\/macos-signing-keychain\.sh/u);
  assert.match(workflow, /prepare_developer_id_keychain "\$certificate" "\$intermediate" "\$keychain" "\$keychain_password"/u);
  assert.ok(chainStep < buildStep);
  assert.match(
    signingPreparation,
    /https:\/\/www\.apple\.com\/certificateauthority\/DeveloperIDG2CA\.cer/,
  );
  assert.match(
    signingPreparation,
    /f16cd3c54c7f83cea4bf1a3e6a0819c8aaa8e4a1528fd144715f350643d2df3a/,
  );
  assert.match(signingPreparation, /security import "\$intermediate" -k "\$keychain"/);
  assert.match(signingPreparation, /security import "\$certificate" -k "\$keychain"/);
  assert.match(workflow, /echo "CSC_KEYCHAIN=\$keychain" >> "\$GITHUB_ENV"/);
  assert.match(signingPreparation, /macos-keychain-search-list\.sh add "\$keychain"/);
  const arm64Build = workflow.slice(
    workflow.indexOf("name: Build signed macOS app (arm64)"),
    workflow.indexOf("name: Verify macOS app signing identity"),
  );
  const packaging = workflow.slice(
    workflow.indexOf("name: Package macOS artifacts"),
    workflow.indexOf("name: Stage stable macOS release assets on runner"),
  );
  for (const step of [arm64Build, packaging]) {
    assert.match(step, /unset CSC_LINK CSC_KEY_PASSWORD/);
  }
  const macosRelease = workflow.slice(
    workflow.indexOf("\n  release:\n"),
    workflow.indexOf("\n  windows-release:\n"),
  );
  assert.doesNotMatch(macosRelease, /--x64|xMatrix-\$DESKTOP_VERSION-x64\.(?:dmg|zip)/u);
  assert.match(workflow, /name: Remove isolated Developer ID signing keychain/);
  assert.match(workflow, /macos-keychain-search-list\.sh remove "\$CSC_KEYCHAIN"/);
  assert.match(workflow, /security delete-keychain "\$CSC_KEYCHAIN"/);
  assert.doesNotMatch(workflow, /login\.keychain-db/);
});

test("macOS desktop releases use resilient checksum-aware binary mirrors and caches", () => {
  assert.match(
    workflow,
    /ELECTRON_MIRROR: https:\/\/npmmirror\.com\/mirrors\/electron\//,
  );
  assert.match(
    workflow,
    /ELECTRON_BUILDER_BINARIES_MIRROR: https:\/\/npmmirror\.com\/mirrors\/electron-builder-binaries\//,
  );
  assert.doesNotMatch(workflow, /rm -rf "\$HOME\/Library\/Caches\/electron"/);
  assert.doesNotMatch(
    workflow,
    /rm -rf "\$HOME\/Library\/Caches\/electron-builder"/,
  );
  assert.doesNotMatch(workflow, /rm -rf "\$HOME\/Library\/pnpm"/);

  // One install policy for the macOS CLI and Desktop release jobs.
  const macosInstall = fs.readFileSync(
    path.join(rootDir, ".github", "actions", "macos-pnpm-install", "action.yml"),
    "utf8",
  );
  assert.match(macosInstall, /pnpm_config_fetch_timeout: "\d+"/);
  assert.match(macosInstall, /pnpm_config_fetch_retries: "\d+"/);
  assert.doesNotMatch(macosInstall, /unset .*PROXY|NO_PROXY=["']?\*/);
  assert.match(workflow, /name: Install dependencies\n\s+uses: \.\/\.github\/actions\/macos-pnpm-install/);
  assert.doesNotMatch(workflow, /pnpm store prune/);
  const cliBuild = fs.readFileSync(
    path.join(rootDir, ".github", "workflows", "cli-build.yml"),
    "utf8",
  );
  const cliMacosInstall = cliBuild.indexOf("if: runner.os == 'macOS'");
  assert.ok(cliMacosInstall >= 0);
  assert.match(
    cliBuild.slice(cliMacosInstall, cliBuild.indexOf("\n\n", cliMacosInstall)),
    /uses: \.\/\.github\/actions\/macos-pnpm-install/,
  );

  const packageStart = workflow.indexOf("name: Package macOS artifacts");
  const packageEnd = workflow.indexOf("name: Stage stable macOS release assets on runner");
  assert.ok(packageStart >= 0);
  assert.ok(packageEnd > packageStart);
  const packageStep = workflow.slice(packageStart, packageEnd);
  assert.equal(
    (
      packageStep.match(
        /ELECTRON_MIRROR="\$ELECTRON_BUILDER_BINARIES_MIRROR" \\\s+pnpm exec electron-builder --mac dmg zip/g,
      ) ?? []
    ).length,
    1,
  );
});
