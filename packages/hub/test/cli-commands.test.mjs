import assert from "node:assert/strict";
import { test } from "node:test";

import { CliRouteError, runCliCommand } from "../src/cli-commands.ts";

// A group as the Hub defines one: a required versioned option with an alias, a flag, and a route call.
const GROUP = { door: "Open and close doors" };
const doorId = { name: "door_id", help: "The door's id" };
const version = { name: "version", aliases: ["expected-version"], kind: "integer", required: true,
  help: "The door version this change is based on" };
const COMMANDS = [
  { path: ["door", "list"], about: "List doors", options: [{ name: "json", kind: "flag", help: "Print the Hub's JSON" }],
    run: async (call, { options }) => {
      const { doors } = await call("GET", "/api/doors");
      return { stdout: options.json ? `${JSON.stringify(doors)}\n` : doors.map((door) => `${door.id}\n`).join("") };
    } },
  { path: ["door", "close"], about: "Close one door", positionals: [doorId],
    options: [version, { name: "reason", kind: "string", help: "Why" }],
    run: async (call, { positionals, options }) => ({ stdout: `${JSON.stringify(await call("POST",
      `/api/doors/${encodeURIComponent(positionals.door_id)}/close`,
      { expectedVersion: options.version, ...(options.reason ? { reason: options.reason } : {}) }))}\n` }) },
];

function hub(responses = {}) {
  const calls = [];
  const call = async (method, route, body) => {
    calls.push({ method, route, body });
    const answer = responses[`${method} ${route}`];
    if (answer instanceof Error) throw answer;
    return answer ?? { doors: [] };
  };
  return { calls, run: (argv) => runCliCommand(COMMANDS, GROUP, argv, call) };
}

test("a word the Hub does not define is left for the CLI to report", async () => {
  assert.equal(await hub().run(["logn"]), null);
});

test("a group alone lists its commands; --help on a command shows its arguments", async () => {
  const listing = await hub().run(["door"]);
  assert.equal(listing.exitCode, 2);
  assert.match(listing.stdout, /Usage: xmatrix door <COMMAND>/);
  assert.match(listing.stdout, /close\s+Close one door/);
  assert.equal((await hub().run(["door", "--help"])).exitCode, 0);
  const help = await hub().run(["door", "close", "--help"]);
  assert.match(help.stdout, /Usage: xmatrix door close \[OPTIONS\] --version <VERSION> <DOOR_ID>/);
  assert.match(help.stdout, /--version <VERSION>.*\(required\) \[aliases: --expected-version\]/);
  const typo = await hub().run(["door", "clsoe"]);
  assert.equal(typo.exitCode, 2);
  assert.match(typo.stderr, /unrecognized subcommand 'clsoe'/);
});

test("a command's options reach its route as typed values, and what it cannot parse is refused before any call", async () => {
  const { calls, run } = hub({ "GET /api/doors": { doors: [{ id: "d1" }, { id: "d2" }] },
    "POST /api/doors/d%2F1/close": { door: { id: "d/1" } } });
  assert.deepEqual(await run(["door", "list"]), { stdout: "d1\nd2\n" });
  assert.deepEqual(JSON.parse((await run(["door", "list", "--json"])).stdout), [{ id: "d1" }, { id: "d2" }]);
  const closed = await run(["door", "close", "d/1", "--expected-version", "4", "--reason=draughty"]);
  assert.deepEqual(JSON.parse(closed.stdout), { door: { id: "d/1" } });
  assert.deepEqual(calls.at(-1), { method: "POST", route: "/api/doors/d%2F1/close",
    body: { expectedVersion: 4, reason: "draughty" } });

  const sent = calls.length;
  const missing = await run(["door", "close", "d1"]);
  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr, /required arguments were not provided:\n  --version <VERSION>/);
  assert.match((await run(["door", "close", "d1", "--version", "seven"])).stderr, /not a whole number/);
  assert.match((await run(["door", "close", "d1", "--version", "1", "--force"])).stderr, /unexpected argument '--force'/);
  assert.equal(calls.length, sent);

  const denied = hub({ "POST /api/doors/d1/close": new CliRouteError(403, "Forbidden (HTTP 403)") });
  assert.deepEqual(await denied.run(["door", "close", "d1", "--version", "1"]),
    { stdout: "", stderr: "error: Forbidden (HTTP 403)\n", exitCode: 1 });
});

// `settings ask` takes any number of addresses and repeated suggestions; the Hub, not the command, decides what each is.
test("settings ask posts every address and suggestion it is given, and status reads them back", async () => {
  const { SETTINGS_COMMANDS, SETTINGS_GROUP } = await import("../src/cli-commands-settings.ts");
  const descriptor = { address: "connector:appstoreconnect/webSession", state: "missing", satisfied: false,
    scope: "App Store Connect", label: "Web session" };
  const calls = [];
  const run = (argv) => runCliCommand(SETTINGS_COMMANDS, SETTINGS_GROUP, argv, async (method, route, body) => {
    calls.push({ method, route, body });
    return route.startsWith("/api/settings-requests/status") ? { settled: false, settings: [descriptor] }
      : { settings: [descriptor.address], descriptors: [descriptor] };
  });
  const asked = await run(["settings", "ask", "connector:appstoreconnect/webSession", "secret:token", "--reason", "sales",
    "--propose", "connector:appstoreconnect/vendorNumber=876=54", "--propose=connector:x/y=1"]);
  assert.match(asked.stdout, /wakes you/);
  assert.match(asked.stdout, /connector:appstoreconnect\/webSession\tmissing\tApp Store Connect: Web session/);
  const [{ body }] = calls;
  assert.deepEqual(body.settings, ["connector:appstoreconnect/webSession", "secret:token"]);
  assert.deepEqual(body.proposals, { "connector:appstoreconnect/vendorNumber": "876=54", "connector:x/y": "1" });
  assert.equal(body.reason, "sales");
  assert.match(body.requestId, /^[0-9a-f-]{36}$/u, "each ask is a new card; a retry of the same call replays it");
  assert.equal((await run(["settings", "ask"])).exitCode, 2, "at least one address");
  assert.match((await run(["settings", "ask", "secret:a", "--propose", "novalue"])).stderr, /--propose takes <address>=<value>/);
  assert.match((await run(["settings", "ask", "--help"])).stdout, /<SETTING>\.\.\./);

  await run(["settings", "status", "secret:a", "secret:b", "--since", "2026-11-01T10:00:00Z"]);
  assert.equal(calls.at(-1).route, "/api/settings-requests/status?setting=secret%3Aa&setting=secret%3Ab&since=2026-11-01T10%3A00%3A00Z");
  assert.match((await run(["settings"])).stdout, /ask\s+Ask, on a card/);
});
