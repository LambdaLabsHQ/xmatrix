const assert = require("node:assert/strict");
const test = require("node:test");

let cliContext;

test.before(async () => {
  cliContext = await import("./cli-context.ts");
});

const isAbsolute = (candidate) => candidate.startsWith("/");

test("the installed CLI wins, then the seed, then a bare PATH name", () => {
  const exists = (candidate) => ["/usr/local/bin/xmatrix", "/App/Resources/cli/xmatrix"].includes(candidate);
  assert.equal(
    cliContext.resolveSessionCli({ installed: "/usr/local/bin/xmatrix", seed: "/App/Resources/cli/xmatrix", exists, isAbsolute }),
    "/usr/local/bin/xmatrix",
  );
  assert.equal(
    cliContext.resolveSessionCli({ installed: "/missing/xmatrix", seed: "/App/Resources/cli/xmatrix", exists, isAbsolute }),
    "/App/Resources/cli/xmatrix",
  );
  assert.equal(
    cliContext.resolveSessionCli({ installed: "xmatrix", seed: "/App/Resources/cli/xmatrix", exists, isAbsolute }),
    "/App/Resources/cli/xmatrix",
  );
  assert.equal(
    cliContext.resolveSessionCli({ installed: "xmatrix", seed: "/nowhere/xmatrix", exists, isAbsolute }),
    "xmatrix",
  );
  assert.equal(
    cliContext.resolveSessionCli({ installed: null, seed: "/nowhere/xmatrix", exists, isAbsolute }),
    null,
  );
});

test("session commands select the profile before the subcommand and never put tokens in argv", () => {
  assert.deepEqual(cliContext.sessionCliArgs("show"), ["session", "show", "--json"]);
  assert.deepEqual(
    cliContext.sessionCliArgs("show", { profileId: "profile:abc", withToken: true }),
    ["--profile", "profile:abc", "session", "show", "--json", "--with-token"],
  );
  assert.deepEqual(
    cliContext.sessionCliArgs("import", { profileId: "profile:abc", withToken: true }),
    ["--profile", "profile:abc", "session", "import", "--stdin", "--json"],
  );
});

test("the CLI's context report is parsed and anything else is no context", async () => {
  const report = {
    hubUrl: "https://xmatrix-hub.xmatrix.sh",
    profile: { id: "profile:1", name: "production", hubUrl: "https://xmatrix-hub.xmatrix.sh", stateRoot: "/Users/me/.config/xmatrix", revision: 3, stateKind: "legacy-root" },
    session: { hubUrl: "https://xmatrix-hub.xmatrix.sh", relayUrl: "wss://xmatrix-hub.xmatrix.sh/ws/humans", user: { id: "user:1", email: "a@example.com", name: "A" }, updatedAt: "1", expiresAt: "2", token: "tok" },
    machineId: "machine:1",
  };
  const calls = [];
  const context = await cliContext.readCliContext({
    executable: "/usr/local/bin/xmatrix",
    profileId: "profile:1",
    withToken: true,
    env: { PATH: "/usr/bin" },
    run: async (file, args, options) => { calls.push({ file, args, timeout: options.timeout, input: options.input }); return { stdout: `warning line\n${JSON.stringify(report)}\n`, stderr: "" }; },
  });
  assert.deepEqual(calls, [{ file: "/usr/local/bin/xmatrix", args: ["--profile", "profile:1", "session", "show", "--json", "--with-token"], timeout: 15_000, input: undefined }]);
  assert.deepEqual(context, report);

  const failed = await cliContext.readCliContext({ executable: "xmatrix", env: {}, run: async () => { throw new Error("ENOENT"); } });
  assert.equal(failed, null);
  const malformed = await cliContext.readCliContext({ executable: "xmatrix", env: {}, run: async () => ({ stdout: "not json\n", stderr: "" }) });
  assert.equal(malformed, null);
  const noProfile = await cliContext.readCliContext({ executable: "xmatrix", env: {}, run: async () => ({ stdout: JSON.stringify({ hubUrl: "https://h", profile: null, session: null, machineId: null }), stderr: "" }) });
  assert.deepEqual(noProfile, { hubUrl: "https://h", profile: null, session: null, machineId: null });
});

test("a session import goes over stdin and returns the CLI's outcome", async () => {
  const calls = [];
  const payload = { token: "t", refreshToken: "r", user: { id: "user:1", email: "a@example.com" }, hubUrl: "https://xmatrix-hub.xmatrix.sh", relayUrl: "wss://xmatrix-hub.xmatrix.sh/ws" };
  const outcome = await cliContext.importCliSession({
    executable: "/App/Resources/cli/xmatrix",
    payload,
    env: {},
    run: async (file, args, options) => {
      calls.push({ file, args, input: options.input, timeout: options.timeout });
      return { stdout: `${JSON.stringify({ hubUrl: "https://xmatrix-hub.xmatrix.sh", userId: "user:1", updatedAt: "10", expiresAt: "20", daemon: "reloaded" })}\n`, stderr: "" };
    },
  });
  assert.deepEqual(calls, [{ file: "/App/Resources/cli/xmatrix", args: ["session", "import", "--stdin", "--json"], input: `${JSON.stringify(payload)}\n`, timeout: 30_000 }]);
  assert.deepEqual(outcome, { hubUrl: "https://xmatrix-hub.xmatrix.sh", userId: "user:1", updatedAt: "10", expiresAt: "20", daemon: "reloaded" });

  await assert.rejects(
    cliContext.importCliSession({ executable: "xmatrix", payload, env: {}, run: async () => { throw new Error("error: This profile is bound to https://a; refusing credentials for https://b"); } }),
    /bound to https:\/\/a/,
  );
  await assert.rejects(
    cliContext.importCliSession({ executable: "xmatrix", payload, env: {}, run: async () => ({ stdout: "saved\n", stderr: "" }) }),
    /did not report a session import result/,
  );
});

test("an unnamed Machine import is saved without reporting a running daemon", async () => {
  const report = { hubUrl: "https://hub", userId: "user:1", updatedAt: "1", expiresAt: "2", daemon: "machine-name-required" };
  const outcome = await cliContext.importCliSession({
    executable: "xmatrix", payload: {}, env: {},
    run: async () => ({ stdout: JSON.stringify(report), stderr: "" }),
  });
  assert.equal(outcome.daemon, "machine-name-required");
});

test("only a replaced daemon process asks for the CLI context again", () => {
  const changed = cliContext.daemonProcessChangeTracker();
  assert.equal(changed(undefined), false, "no process yet");
  assert.equal(changed(100), false, "the first daemon was read with the startup context");
  assert.equal(changed(100), false, "the same daemon on every heartbeat");
  assert.equal(changed(200), true, "a restarted daemon, e.g. after the CLI updated itself");
  assert.equal(changed(200), false);
});
