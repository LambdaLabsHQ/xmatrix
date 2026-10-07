const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { summonAtCompletion, findLaunchFieldCompletion, filterLaunchCandidates, autoLaunchCandidates, completeLaunchFragment, summonStartCandidates } = require("./auto-launch-completion.ts");

test("runtime picks are top-level addresses and their conditions continue at the caret", () => {
  assert.equal(completeLaunchFragment("@cod", { start: 0, tokenEnd: 4 }, { harness: "codex" }).value, "@codex ");
  const body = "@claude repo:";
  assert.equal(completeLaunchFragment(body, { start: 8, tokenEnd: body.length }, { repo: "owner/repo" }).value,
    "@claude repo:owner/repo ");
  assert.equal(summonAtCompletion("@claude ", 8).tags.harness, "claude");
});

/** Where the `@` word being completed starts, marked with `|` in the fixture. */
function at(marked) {
  const start = marked.indexOf("|");
  return { body: marked.replace("|", ""), start };
}

test("a condition joins the summon it is typed onto", () => {
  const { body, start } = at("@auto repo:owner/app look at this @auto harness:codex |");
  const summon = summonAtCompletion(body, start);
  assert.equal(summon.text, "@auto harness:codex");
  assert.deepEqual(summon.tags, { harness: "codex" });
});

test("only whitespace may separate the summon from the word being completed", () => {
  // Once a word intervenes the author has moved on; the pick would otherwise
  // land on a summon they stopped writing sentences ago.
  const { body, start } = at("@auto repo:owner/app look at this |");
  assert.equal(summonAtCompletion(body, start), undefined);
  const glued = at("@auto repo:owner/app|");
  assert.equal(summonAtCompletion(glued.body, glued.start).text, "@auto repo:owner/app");
});

test("a summon later in the message wins over the first one", () => {
  const { body, start } = at("@auto repo:owner/app and @auto |");
  assert.equal(summonAtCompletion(body, start).text, "@auto");
});

test("a malformed summon takes nothing", () => {
  // Adding to a summon that already fails closed would hide the error behind a
  // condition the author cannot see was rejected.
  const { body, start } = at("@auto repo:a/b repo:c/d |");
  assert.equal(summonAtCompletion(body, start), undefined);
});

test("a message with no summon before the caret has no target", () => {
  const { body, start } = at("look at this |");
  assert.equal(summonAtCompletion(body, start), undefined);
});

test("an explicit pick changes only its active fragment", () => {
  for (const prefix of ['  prose @auto effort:high repo:"owner/app"  ', '@auto first\n@auto  ', 'before ']) {
    const body = prefix + '@model:te after  ';
    const result = completeLaunchFragment(body, { start: prefix.length, tokenEnd: prefix.length + 9 }, { model: "test-model" });
    assert.ok(result.value.startsWith(prefix));
    assert.ok(result.value.endsWith(' after  '));
  }
  const body = '@auto  @auto';
  assert.equal(completeLaunchFragment(body, { start: 7, tokenEnd: 12 }, {}).value, '@auto  @auto ');
});

const registrations = [{ key: { ownerUserId: "owner", machineId: "mac", harness: "codex" }, machineName: "Mac",
  models: ["test-model"], state: "enabled", routingReady: true,
  modelCatalog: [{ model: "test-model", efforts: [{ value: "high" }] }] }];
const targets = { repos: [{ value: "owner/project" }], workspaces: [
  { canonicalCwd: "/work/my project", ownerUserId: "owner", machineId: "mac", hostName: "Mac" }
] };

test("a directory names its Machine as the owner did, never by hostname", () => {
  const hosted = { repos: [], workspaces: [{ canonicalCwd: "/work/bot", ownerUserId: "owner", machineId: "mac", hostName: "cursor" }] };
  const named = [{ ...registrations[0], machineName: "Grok Bot Machine" }];
  const directory = autoLaunchCandidates(hosted, {}, named).find(candidate => candidate.launchTags.pwd === "/work/bot");
  assert.equal(directory.launchTags.machine, "Grok Bot Machine");
  assert.doesNotMatch(directory.name, /cursor/u);
  const unregistered = autoLaunchCandidates(hosted, {}, []).find(candidate => candidate.launchTags.pwd === "/work/bot");
  assert.equal(unregistered.launchTags.machine, "mac");
  assert.doesNotMatch(unregistered.name, /cursor/u);
});

test("new field syntax searches exact fields as well as ordinary @ text", () => {
  const choices = autoLaunchCandidates(targets, {}, registrations);
  for (const [query, field, value] of [
    ["repo:own", "repo", "owner/project"], ["pwd:\"/work/my", "pwd", "/work/my project"],
    ["machine:mac", "machine", "Mac"], ["harness:cod", "harness", "codex"],
    ["model:test", "model", "test-model"], ["effort:high", "effort", "high"],
  ]) {
    const matches = filterLaunchCandidates(choices, query);
    assert.ok(matches.some(candidate => candidate.launchTags[field] === value), query);
    assert.ok(matches.every(candidate => candidate.launchTags[field] !== undefined), query);
  }
  assert.deepEqual(filterLaunchCandidates(choices, "mode:persistent"), []);
});

test("a fresh @ offers only runtimes; conditions wait for the summon", () => {
  const start = summonStartCandidates(autoLaunchCandidates(targets, {}, registrations));
  assert.deepEqual(start.map(candidate => candidate.name), ["Auto", "@codex"]);
  assert.ok(start.every(candidate => candidate.kind === "agent"));
  const continued = autoLaunchCandidates(targets, { harness: "codex" }, registrations);
  for (const field of ["repo", "pwd", "machine", "model", "effort"]) {
    assert.ok(continued.some(candidate => candidate.launchTags[field] !== undefined), field);
  }
});

test("a condition that is already set offers none of its field's options", () => {
  const twoRepos = { repos: [{ value: "owner/one" }, { value: "owner/two" }], workspaces: [] };
  assert.deepEqual(
    autoLaunchCandidates(twoRepos, {}).filter(candidate => candidate.launchTags.repo).map(candidate => candidate.launchTags.repo),
    ["owner/one", "owner/two"],
  );
  assert.deepEqual(
    autoLaunchCandidates(twoRepos, { repo: "owner/one" }).filter(candidate => candidate.launchTags.repo),
    [],
    "the set repo hides every repo option, not only the one chosen",
  );
  const twoDirectories = { repos: [], workspaces: [
    { canonicalCwd: "/work/a", machineId: "mac", hostName: "Mac" },
    { canonicalCwd: "/work/b", machineId: "mac", hostName: "Mac" },
  ] };
  assert.deepEqual(
    autoLaunchCandidates(twoDirectories, { pwd: "/work/a" })
      .filter(candidate => candidate.launchTags.pwd).map(candidate => candidate.launchTags.pwd),
    [],
    "the set directory hides every directory option",
  );
});

test("a repository and a directory exclude each other", () => {
  const both = { repos: [{ value: "owner/one" }], workspaces: [
    { canonicalCwd: "/work/a", machineId: "mac", hostName: "Mac" },
  ] };
  const where = candidates => candidates.filter(candidate => candidate.launchTags.repo || candidate.launchTags.pwd);
  assert.equal(where(autoLaunchCandidates(both, {})).length, 2);
  assert.deepEqual(where(autoLaunchCandidates(both, { repo: "owner/one" })), [], "a set repo offers no directory");
  assert.deepEqual(where(autoLaunchCandidates(both, { pwd: "/work/a" })), [], "a set directory offers no repo");
});

test("machine completion writes the host name, and an unnamed machine keeps its scoped ID", () => {
  const id = "machine:c04a3f1d-a863-477d-b169-5a089ed17971";
  const short = id.slice("machine:".length);
  const { parseAutoLaunchMentions } = require("@xmatrix/protocol");
  const draft = "@auto machine:";
  const named = autoLaunchCandidates(undefined, {}, [{ ...registrations[0], key: { machineId: id, harness: "codex" }, machineName: "Workstation" }])
    .find(candidate => candidate.launchTags.machine === "Workstation");
  const completed = completeLaunchFragment(draft, { start: 6, tokenEnd: draft.length }, named.launchTags);
  assert.equal(completed.value, "@auto machine:Workstation ");
  assert.equal(parseAutoLaunchMentions(completed.value)[0].tags.machine, "Workstation");
  const unnamed = autoLaunchCandidates(undefined, {}, [{ ...registrations[0], key: { machineId: id, harness: "codex" }, machineName: "" }])
    .find(candidate => candidate.launchTags.machine === id);
  const scoped = completeLaunchFragment(draft, { start: 6, tokenEnd: draft.length }, unnamed.launchTags);
  assert.equal(scoped.value, `@auto machine:${short} `);
  assert.equal(parseAutoLaunchMentions(scoped.value)[0].tags.machine, id);
});

test("plain fields complete only at the summon boundary, preserving quoted token spans", () => {
  for (const text of ["repo:", "model:tes", "effort:h", "rep"]) {
    assert.equal(findLaunchFieldCompletion("@auto " + text, text.length + 6).query, text);
    assert.equal(findLaunchFieldCompletion(text, text.length), null);
  }
  const body = '@auto pwd:"/work/my project" task';
  const cursor = body.indexOf("my") + 2;
  const active = findLaunchFieldCompletion(body, cursor);
  assert.equal(body.slice(active.start, active.tokenEnd), 'pwd:"/work/my project"');
  for (const text of ["Explain repo:", "@auto Explain repo:", "@codex:new:repo", "mode:once"]) {
    assert.equal(findLaunchFieldCompletion(text, text.length), null, text);
  }
});

test("condition picks serialize only the supported launch grammar", () => {
  const { formatAutoLaunchMention, parseAutoLaunchMentions } = require("@xmatrix/protocol");
  const choices = autoLaunchCandidates(targets, {}, registrations);
  let tags = {};
  for (const query of ["harness:cod", "pwd:\"/work/my", "effort:high"]) {
    tags = { ...tags, ...filterLaunchCandidates(choices, query)[0].launchTags };
  }
  const body = formatAutoLaunchMention(tags) + " Check tests";
  const parsed = parseAutoLaunchMentions(body)[0];
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.tags, { harness: "codex", pwd: "/work/my project", machine: "Mac", effort: "high" });
  assert.doesNotMatch(body, /:(?:new|once)|mode:/u);
});


test("registration facts respect explicit constraints", () => {
  const catalog = [
    { key: { machineId: "new-mac", harness: "codex" }, machineName: "New Mac", models: ["new-model"], state: "enabled", routingReady: true },
    { key: { machineId: "other", harness: "claude" }, machineName: "Other", models: ["other-model"], state: "enabled", routingReady: true },
    { key: { machineId: "revoked", harness: "codex" }, machineName: "Revoked", models: ["secret-model"], state: "revoked", routingReady: true },
  ];
  const choices = autoLaunchCandidates(targets, { harness: "codex" }, catalog);
  // This catalog has no name for the directory's Machine, so it is spoken by id, never by hostname.
  assert.deepEqual(choices.filter(item => item.launchTags.machine).map(item => item.launchTags.machine), ["mac", "New Mac"]);
  assert.deepEqual(choices.filter(item => item.launchTags.model).map(item => item.launchTags.model), ["new-model"]);
  assert.deepEqual(autoLaunchCandidates(undefined, {}, []).filter(item => item.launchTags.model), []);
});


test("an offline machine stays listed and cannot be chosen", () => {
  const offline = { ...registrations[0], machineName: "Laptop", key: { ...registrations[0].key, machineId: "laptop" },
    live: { machine: { online: false }, running: [] } };
  const online = { ...registrations[0], machineName: "Studio", key: { ...registrations[0].key, machineId: "studio" },
    live: { machine: { online: true }, running: [] } };
  const rows = autoLaunchCandidates(undefined, {}, [offline, online]);
  const laptop = rows.find(candidate => candidate.launchTags.machine === "Laptop");
  const studio = rows.find(candidate => candidate.launchTags.machine === "Studio");
  assert.equal(laptop.unavailable, "Offline");
  assert.equal(laptop.description, "Offline");
  assert.equal(studio.unavailable, undefined);
  const directory = autoLaunchCandidates({ repos: [], workspaces: [
    { canonicalCwd: "/work/laptop", ownerUserId: "owner", machineId: "laptop", hostName: "laptop" },
  ] }, {}, [offline]).find(candidate => candidate.launchTags.pwd === "/work/laptop");
  assert.equal(directory.unavailable, "Offline");
});

test("an empty model list offers no model or effort; the harness is never a model", () => {
  const registration = { key: { machineId: "mac", harness: "claude" }, machineName: "Mac",
    models: [], state: "enabled", routingReady: true,
    modelCatalog: [{ model: "claude-opus-4-6", efforts: [{ value: "high" }] }] };
  const tags = (rows, field) => rows.filter(item => item.launchTags[field]).map(item => item.launchTags[field]);
  const rows = autoLaunchCandidates(undefined, {}, [registration]);
  assert.deepEqual(tags(rows, "model"), []);
  assert.deepEqual(tags(rows, "effort"), []);
  assert.deepEqual(tags(rows, "harness"), ["claude"]);
  assert.deepEqual(tags(autoLaunchCandidates(undefined, { model: "claude" }, [registration]), "machine"), [],
    "a registration with no allowed model cannot satisfy a model constraint");
});

test("an explicit model list offers its observed models, else the list itself, compared literally", () => {
  const registration = { key: { machineId: "mac", harness: "claude" }, machineName: "Mac",
    models: ["claude-opus-4-6", "claude-sonnet-4-6"], state: "enabled", routingReady: true,
    modelCatalog: [{ model: "claude-opus-4-6", efforts: [{ value: "high" }] }, { model: "other", efforts: [{ value: "max" }] }] };
  const tags = (rows, field) => rows.filter(item => item.launchTags[field]).map(item => item.launchTags[field]);
  const rows = autoLaunchCandidates(undefined, {}, [registration]);
  assert.deepEqual(tags(rows, "model"), ["claude-opus-4-6"]);
  assert.deepEqual(tags(rows, "effort"), ["high"]);
  assert.deepEqual(tags(autoLaunchCandidates(undefined, {}, [{ ...registration, modelCatalog: undefined }]), "model"),
    ["claude-opus-4-6", "claude-sonnet-4-6"]);
});

test("registration effort suggestions use only the selected authorized model observation", () => {
  const registration = { key: { machineId: "mac", harness: "codex" }, machineName: "Mac",
    models: ["a", "b"], state: "enabled", routingReady: true,
    modelCatalog: [
      { model: "a", efforts: [{ value: "high" }] },
      { model: "b", efforts: [{ value: "low" }] },
      { model: "private", efforts: [{ value: "max" }] },
    ] };
  const efforts = rows => rows.filter(item => item.launchTags.effort).map(item => item.launchTags.effort);
  assert.deepEqual(efforts(autoLaunchCandidates(undefined, { model: "a" }, [registration])), ["high"]);
  assert.deepEqual(efforts(autoLaunchCandidates(undefined, {}, [{ ...registration, modelCatalog: undefined }])), []);
});


test("future parameter choices complete for any harness and preserve other tags", () => {
  const registration = { key: { machineId: "machine", harness: "kimi" }, state: "enabled", routingReady: true,
    machineName: "Machine", models: ["model"], parameters: [{ id: "future-speed", label: "Speed", options: ["turbo", "very fast"] }], parameterModel: "model" };
  const candidates = autoLaunchCandidates(undefined, { harness: "kimi" }, [registration]);
  const body = "@kimi param.future-speed:very";
  const active = findLaunchFieldCompletion(body, body.length);
  const picked = filterLaunchCandidates(candidates, active.query);
  assert.equal(picked.length, 1);
  const result = completeLaunchFragment(body, active, picked[0].launchTags);
  assert.equal(result.value, '@kimi param.future-speed:"very fast" ');
  assert.equal(autoLaunchCandidates(undefined, { parameters: JSON.stringify({ "future-speed": "turbo" }) }, [registration])
    .some(candidate => candidate.launchTags?.parameters), false);
  assert.equal(autoLaunchCandidates(undefined, { model: "other" }, [registration]).some(candidate => candidate.launchTags?.parameters), false);
});


test("machine field completion excludes directories carrying a machine constraint", () => {
  const catalog = [{ ...registrations[0], machineName: "srv2006562" }];
  const choices = autoLaunchCandidates(targets, { harness: "codex" }, catalog);
  for (const value of ["", "s", "srv", "srv200", "srv2006562"]) {
    const body = "@codex machine:" + value;
    const active = findLaunchFieldCompletion(body, body.length);
    const matches = filterLaunchCandidates(choices, active.query);
    assert.deepEqual(matches.map(row => row.name), ["machine:srv2006562"]);
    assert.equal(completeLaunchFragment(body, active, matches[0].launchTags).value,
      "@codex machine:srv2006562 ");
  }
});

test("a machine selected by name keeps that machine's remaining field choices", () => {
  const selected = { harness: "codex", machine: "Mac" };
  const choices = autoLaunchCandidates(targets, selected, registrations);
  assert.ok(choices.some(row => row.launchTags.pwd === "/work/my project"));
  assert.ok(choices.some(row => row.launchTags.model === "test-model"));
  assert.ok(choices.some(row => row.launchTags.effort === "high"));
  assert.equal(choices.some(row => row.launchField === "machine"), false);
  const other = autoLaunchCandidates(targets, { ...selected, machine: "Other" }, registrations);
  assert.equal(other.some(row => ["pwd", "model", "effort"].includes(row.launchField)), false);
});
