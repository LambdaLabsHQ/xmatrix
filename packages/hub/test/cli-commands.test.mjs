import assert from "node:assert/strict";
import { test } from "node:test";

import { CliRouteError, runCliCommand } from "../src/cli-commands.ts";
import { AUTOMATION_COMMANDS, AUTOMATION_GROUP } from "../src/cli-commands-automation.ts";

function hub(responses = {}) {
  const calls = [];
  const call = async (method, route, body) => {
    calls.push({ method, route, body });
    const answer = responses[`${method} ${route.split("?")[0]}`];
    if (answer instanceof Error) throw answer;
    return answer ?? { agentManagementEnabled: true, automations: [] };
  };
  return { calls, run: (argv) => runCliCommand(AUTOMATION_COMMANDS, AUTOMATION_GROUP, argv, call) };
}

test("a word the Hub does not define is left for the CLI to report", async () => {
  assert.equal(await hub().run(["logn"]), null);
});

test("a group alone lists its commands; --help on a command shows its arguments", async () => {
  const listing = await hub().run(["automation"]);
  assert.equal(listing.exitCode, 2);
  assert.match(listing.stdout, /Usage: xmatrix automation <COMMAND>/);
  assert.match(listing.stdout, /cancel-execution\s+Cancel one exact execution/);
  assert.equal((await hub().run(["automation", "--help"])).exitCode, 0);
  const help = await hub().run(["automation", "pause", "--help"]);
  assert.match(help.stdout, /Usage: xmatrix automation pause \[OPTIONS\] --version <VERSION> <AUTOMATION_ID>/);
  assert.match(help.stdout, /--version <VERSION>.*\(required\) \[aliases: --expected-version\]/);
  const typo = await hub().run(["automation", "paws"]);
  assert.equal(typo.exitCode, 2);
  assert.match(typo.stderr, /unrecognized subcommand 'paws'/);
});

test("list prints one line per Automation, or the Hub's JSON", async () => {
  const automations = [{ id: "a1", version: 3, enabled: true, name: "Daily" }, { id: "a2", version: 1, enabled: false }];
  const { calls, run } = hub({ "GET /api/automations": { agentManagementEnabled: true, automations } });
  assert.deepEqual(await run(["automation", "list", "--channel", "c 1"]),
    { stdout: "a1\tv3\tactive\tDaily\na2\tv1\tpaused\tunnamed\n" });
  assert.equal(calls[0].route, "/api/automations?channelId=c%201");
  assert.deepEqual(JSON.parse((await run(["automation", "list", "--space=s1", "--json"])).stdout), automations);
  assert.equal(calls[1].route, "/api/automations?spaceId=s1");
  assert.equal((await run(["automation", "list"])).exitCode, 2);
  assert.equal((await run(["automation", "list", "--channel", "c", "--space", "s"])).exitCode, 2);
});

test("a change carries its version and reason, and is refused before sending when management is off", async () => {
  const { calls, run } = hub({ "PATCH /api/automations/a%2F1": { automation: { id: "a/1" } } });
  const updated = await run(["automation", "update", "a/1", "--expected-version", "4", "--message", "Check CI",
    "--every", "30", "--reason", "slower"]);
  assert.deepEqual(JSON.parse(updated.stdout), { automation: { id: "a/1" } });
  assert.deepEqual(calls.at(-1), { method: "PATCH", route: "/api/automations/a%2F1", body: { expectedVersion: 4,
    reason: "slower", expression: { kind: "text", language: "natural-language", text: "Check CI" }, intervalMinutes: 30 } });
  await run(["automation", "cancel-execution", "a1", "--run-id", "run:1"]);
  assert.deepEqual(calls.at(-1), { method: "POST", route: "/api/automations/a1/cancel-execution", body: { runId: "run:1" } });
  await run(["automation", "delete", "a1", "--version", "2"]);
  assert.deepEqual(calls.at(-1), { method: "DELETE", route: "/api/automations/a1", body: { expectedVersion: 2 } });

  const missing = await run(["automation", "pause", "a1"]);
  assert.equal(missing.exitCode, 2);
  assert.match(missing.stderr, /required arguments were not provided:\n  --version <VERSION>/);
  assert.match((await run(["automation", "pause", "a1", "--version", "seven"])).stderr, /not a whole number/);
  assert.match((await run(["automation", "pause", "a1", "--version", "1", "--force"])).stderr, /unexpected argument '--force'/);

  const off = hub({ "GET /api/automations": { agentManagementEnabled: false } });
  const refused = await off.run(["automation", "resume", "a1", "--version", "1"]);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr, /does not advertise Agent Automation management/);
  assert.equal(off.calls.length, 1, "the mutation itself was never sent");

  const denied = hub({ "POST /api/automations/a1/pause": new CliRouteError(403, "Forbidden (HTTP 403)") });
  assert.deepEqual(await denied.run(["automation", "pause", "a1", "--version", "1"]),
    { stdout: "", stderr: "error: Forbidden (HTTP 403)\n", exitCode: 1 });
});
