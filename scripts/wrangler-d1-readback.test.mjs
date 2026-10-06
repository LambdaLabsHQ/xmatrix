import { assert, spawnSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, tmpdir, path, test, fileURLToPath } from "./script-test-fixture.mjs";
import {
  migrationFilesOnDisk,
  parseWranglerD1Info,
  parseWranglerJsonPayload,
  payloadNames,
} from "./wrangler-d1-readback.mjs";

/** The exact notice that broke the first version of this readback. */
const PROXY_NOTICE = "Proxy environment variables detected. We'll use your proxy for fetch requests.\n";

const TABLES_PAYLOAD = JSON.stringify([
  {
    results: [{ name: "signup_invite_claim" }, { name: "signup_invite_code" }],
    success: true,
    meta: { duration: 1.2 },
  },
]);

test("a payload preceded by wrangler's proxy notice still parses", () => {
  // This is the real-world case: run 31111270512 failed here, on stdout that
  // began with the notice rather than with JSON.
  const payload = parseWranglerJsonPayload(PROXY_NOTICE + TABLES_PAYLOAD);
  assert.deepEqual(payloadNames(payload), ["signup_invite_claim", "signup_invite_code"]);
});

test("noise containing brackets does not derail the parse", () => {
  // Slicing from the first `[` or `{` would start inside the notice here.
  const noisy = [
    "Fetching [remote] state {cached}\n",
    "Using config [wrangler.toml] {env: production}\n",
    TABLES_PAYLOAD,
  ].join("");
  assert.deepEqual(payloadNames(parseWranglerJsonPayload(noisy)), [
    "signup_invite_claim",
    "signup_invite_code",
  ]);
});

test("a bracketed fragment that parses but is the wrong shape is rejected", () => {
  // `{}` and `[1,2]` both parse. Neither is a wrangler payload, and accepting
  // one would mean reporting "no tables" as a successful readback.
  const decoys = "note {} and [1, 2] and [{\"unrelated\": true}]\n";
  assert.throws(() => parseWranglerJsonPayload(decoys), /no wrangler JSON payload/);

  // The same decoys ahead of a real payload must not shadow it.
  assert.deepEqual(payloadNames(parseWranglerJsonPayload(decoys + TABLES_PAYLOAD)), [
    "signup_invite_claim",
    "signup_invite_code",
  ]);
});

test("output printed after the payload does not hide it", () => {
  // `JSON.parse` on the rest of the file requires the remainder to be valid
  // JSON, so a single trailing line would otherwise make the readback report
  // that it found nothing -- the same wrong answer, from the other side.
  const trailing = PROXY_NOTICE + TABLES_PAYLOAD + "\nDone in 1.2s\n";
  assert.deepEqual(payloadNames(parseWranglerJsonPayload(trailing)), [
    "signup_invite_claim",
    "signup_invite_code",
  ]);

  // Noise on both sides, including brackets after the payload.
  const surrounded = `note [x]\n${TABLES_PAYLOAD}\ntrailing {y} [z]\n`;
  assert.deepEqual(payloadNames(parseWranglerJsonPayload(surrounded)), [
    "signup_invite_claim",
    "signup_invite_code",
  ]);
});

test("a bracket inside a string value does not end the payload early", () => {
  // The scanner walks to a balanced end, so it has to respect strings and
  // escapes or a note field could truncate the parse.
  const withBrackets = JSON.stringify([
    { results: [{ name: "signup_invite_code", note: 'a ] and a } and a \\" quote' }], success: true },
  ]);
  const payload = parseWranglerJsonPayload(PROXY_NOTICE + withBrackets);
  assert.deepEqual(payloadNames(payload), ["signup_invite_code"]);
});

test("output with no JSON at all fails closed", () => {
  assert.throws(() => parseWranglerJsonPayload(""), /no output/);
  assert.throws(() => parseWranglerJsonPayload("   \n"), /no output/);
  assert.throws(
    () => parseWranglerJsonPayload("Authentication error [code: 10000]\n"),
    /no wrangler JSON payload/,
  );
});

test("a clean payload parses, including several statements", () => {
  const multi = JSON.stringify([
    { results: [{ name: "0001_better_auth_schema.sql" }], success: true },
    { results: [{ name: "0002_signup_invites.sql" }], success: true },
  ]);
  assert.deepEqual(payloadNames(parseWranglerJsonPayload(multi)), [
    "0001_better_auth_schema.sql",
    "0002_signup_invites.sql",
  ]);
});

test("D1 info parsing requires an exact database identity object", () => {
  const info = {
    uuid: "430fc938-f485-4c41-8d00-3fa85c9c014e",
    name: "xmatrix-auth-test",
    running_in_region: "WNAM",
  };
  assert.deepEqual(parseWranglerD1Info(PROXY_NOTICE + JSON.stringify(info)), info);
  assert.throws(
    () => parseWranglerD1Info(JSON.stringify({ name: "xmatrix-auth-test" })),
    /no wrangler JSON payload/u,
  );
});

test("an empty result set parses as empty rather than as an error", () => {
  // A migration that created nothing is a real answer the caller must see, and
  // is distinct from output that could not be parsed at all.
  const empty = JSON.stringify([{ results: [], success: true }]);
  assert.deepEqual(payloadNames(parseWranglerJsonPayload(empty)), []);
});

test("an empty migrations directory fails rather than passing vacuously", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "xmatrix-migrations-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  assert.throws(() => migrationFilesOnDisk(directory), /no \.sql migrations/);

  writeFileSync(path.join(directory, "0002_b.sql"), "");
  writeFileSync(path.join(directory, "0001_a.sql"), "");
  writeFileSync(path.join(directory, "notes.md"), "");
  assert.deepEqual(migrationFilesOnDisk(directory), ["0001_a.sql", "0002_b.sql"]);
});

/* --------------------------- the CLI exit contract -------------------------- */

/*
 * The workflow depends on the exit code, not on the exported functions: it
 * runs `node scripts/wrangler-d1-readback.mjs ...` under `set -e`. Testing the
 * parser alone would leave the actual acceptance criterion — non-zero when the
 * database is wrong — free to regress with every test still green.
 */

const SCRIPT = fileURLToPath(new URL("./wrangler-d1-readback.mjs", import.meta.url));

/** Run the CLI the way the workflow does, and report what a step would see. */
function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function payloadFile(directory, name, names) {
  const file = path.join(directory, name);
  // Every fixture carries the proxy notice, so each case also exercises the
  // real-world prefix through the actual command path.
  writeFileSync(
    file,
    PROXY_NOTICE + JSON.stringify([{ results: names.map((value) => ({ name: value })), success: true }]),
  );
  return file;
}

function workspace(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "xmatrix-readback-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("CLI tables: exactly the expected pair exits 0", (t) => {
  const directory = workspace(t);
  const file = payloadFile(directory, "ok.json", ["signup_invite_claim", "signup_invite_code"]);
  const { status, stdout } = runCli(["tables", file, "signup_invite_claim,signup_invite_code"]);
  assert.equal(status, 0);
  assert.match(stdout, /signup_invite_claim,signup_invite_code/);
});

test("CLI tables: missing, partial, or extra tables all exit non-zero", (t) => {
  const directory = workspace(t);
  const expected = "signup_invite_claim,signup_invite_code";

  const cases = [
    ["none", []],
    ["partial", ["signup_invite_claim"]],
    ["extra", ["signup_invite_claim", "signup_invite_code", "unexpected_table"]],
  ];
  for (const [label, names] of cases) {
    const file = payloadFile(directory, `${label}.json`, names);
    const { status, stderr } = runCli(["tables", file, expected]);
    assert.notEqual(status, 0, `${label} must fail the step`);
    assert.match(stderr, /expected exactly/, `${label} must say what it wanted`);
  }
});

test("CLI ledger: full coverage exits 0, a gap exits non-zero", (t) => {
  const directory = workspace(t);
  const migrations = path.join(directory, "migrations");
  mkdirSync(migrations);
  writeFileSync(path.join(migrations, "0001_better_auth_schema.sql"), "");
  writeFileSync(path.join(migrations, "0002_signup_invites.sql"), "");

  const complete = payloadFile(directory, "ledger-full.json", [
    "0001_better_auth_schema.sql",
    "0002_signup_invites.sql",
  ]);
  assert.equal(runCli(["ledger", complete, migrations]).status, 0);

  const partial = payloadFile(directory, "ledger-partial.json", ["0001_better_auth_schema.sql"]);
  const gap = runCli(["ledger", partial, migrations]);
  assert.notEqual(gap.status, 0, "a migration missing from the ledger must fail the step");
  assert.match(gap.stderr, /not recorded as applied: 0002_signup_invites\.sql/);
});

test("CLI ledger: an empty migrations directory exits non-zero", (t) => {
  const directory = workspace(t);
  const empty = mkdtempSync(path.join(tmpdir(), "xmatrix-migrations-empty-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));

  const file = payloadFile(directory, "ledger.json", ["0001_better_auth_schema.sql"]);
  const { status, stderr } = runCli(["ledger", file, empty]);
  assert.notEqual(status, 0, "finding no migrations must never pass");
  assert.match(stderr, /no \.sql migrations/);
});

test("CLI database: exact name and UUID pass; either mismatch fails", (t) => {
  const directory = workspace(t);
  const file = path.join(directory, "database.json");
  const uuid = "430fc938-f485-4c41-8d00-3fa85c9c014e";
  writeFileSync(
    file,
    PROXY_NOTICE + JSON.stringify({ uuid, name: "xmatrix-auth-test", running_in_region: "WNAM" }),
  );

  assert.equal(runCli(["database", file, "xmatrix-auth-test", uuid]).status, 0);
  const wrongName = runCli(["database", file, "xmatrix-auth", uuid]);
  assert.notEqual(wrongName.status, 0);
  assert.match(wrongName.stderr, /expected D1 xmatrix-auth/u);
  const wrongUuid = runCli([
    "database",
    file,
    "xmatrix-auth-test",
    "1b639f00-0592-40de-9b0a-8456933f5cfd",
  ]);
  assert.notEqual(wrongUuid.status, 0);
  assert.match(wrongUuid.stderr, /expected D1 xmatrix-auth-test/u);
});

test("CLI: unparseable output and unknown modes exit non-zero", (t) => {
  const directory = workspace(t);
  const broken = path.join(directory, "broken.json");
  writeFileSync(broken, "Authentication error [code: 10000]\n");

  const unparseable = runCli(["tables", broken, "signup_invite_code"]);
  assert.notEqual(unparseable.status, 0);
  assert.match(unparseable.stderr, /no wrangler JSON payload/);

  const unknown = runCli(["wat", broken, "x"]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown mode/);
});
