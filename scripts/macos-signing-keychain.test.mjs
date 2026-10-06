import { assert, fs, os, path, spawnSync, test, rootDir } from "./script-test-fixture.mjs";

const pinnedIntermediate = "f16cd3c54c7f83cea4bf1a3e6a0819c8aaa8e4a1528fd144715f350643d2df3a";

function signingFixture(t, checksum) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xmatrix-signing-prepare-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "bin"));
  fs.mkdirSync(path.join(directory, "scripts"));
  const executable = (name, text) => fs.writeFileSync(path.join(directory, name), `#!/bin/bash\n${text}\n`, { mode: 0o755 });
  executable("bin/curl", 'while [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then printf intermediate > "$2"; exit 0; fi; shift; done; exit 1');
  executable("bin/shasum", 'printf "%s  %s\\n" "$SIGNING_TEST_CHECKSUM" "$3"');
  executable("bin/security", 'printf "%s\\n" "$*" >> "$SIGNING_TEST_LOG"; if [ "$1" = "find-identity" ]; then printf \'1) ABCDEF "Developer ID Application: Fixture (VWN9V9V56Z)"\\n\'; fi');
  executable("scripts/macos-keychain-search-list.sh", 'printf "search-list %s\\n" "$*" >> "$SIGNING_TEST_LOG"');
  fs.writeFileSync(path.join(directory, "source.p12"), "leaf fixture");
  const result = spawnSync("bash", ["-c", `set -euo pipefail
source "$SIGNING_TEST_HELPER"
prepare_developer_id_keychain "$PWD/leaf.p12" "$PWD/intermediate.cer" "$PWD/signing.keychain-db" fixture-password
printf '%s' "$identity"
`], {
    cwd: directory, encoding: "utf8",
    env: {
      ...process.env, PATH: `${path.join(directory, "bin")}:${process.env.PATH}`,
      CSC_LINK: `file://${path.join(directory, "source.p12")}`, CSC_KEY_PASSWORD: "fixture-leaf-password",
      MACOS_RELEASE_TEAM_ID: "VWN9V9V56Z", SIGNING_TEST_CHECKSUM: checksum,
      SIGNING_TEST_LOG: path.join(directory, "calls.log"),
      SIGNING_TEST_HELPER: path.join(rootDir, "scripts/macos-signing-keychain.sh"),
    },
  });
  return { directory, result, calls: fs.existsSync(path.join(directory, "calls.log"))
    ? fs.readFileSync(path.join(directory, "calls.log"), "utf8").trim().split("\n") : [] };
}

test("signing preparation imports the pinned full chain into only the requested isolated keychain", (t) => {
  const { directory, result, calls } = signingFixture(t, pinnedIntermediate);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ABCDEF");
  assert.equal(fs.readFileSync(path.join(directory, "leaf.p12"), "utf8"), "leaf fixture");
  assert.deepEqual(calls.map((line) => line.split(" ")[0]), [
    "create-keychain", "set-keychain-settings", "unlock-keychain", "search-list", "import", "import", "set-key-partition-list", "find-identity",
  ]);
  assert.ok(calls.every((line) => line.includes(path.join(directory, "signing.keychain-db"))));
  assert.match(calls[4], /intermediate\.cer.* -k .*signing\.keychain-db -T \/usr\/bin\/codesign/u);
  assert.match(calls[5], /leaf\.p12.* -k .*signing\.keychain-db -P fixture-leaf-password -T \/usr\/bin\/codesign/u);
});

test("a mismatched Apple intermediate fails before keychain creation or certificate import", (t) => {
  const { result, calls } = signingFixture(t, "wrong-checksum");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unexpected Apple Developer ID G2 certificate checksum/u);
  assert.deepEqual(calls, []);
});
