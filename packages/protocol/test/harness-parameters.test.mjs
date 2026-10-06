import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { harnessParameterKind, harnessParameterEnabled, harnessParameterValue, harnessParameterValueLabel, parseHarnessParameters, parseHarnessParameterValues, validateHarnessParameterValues,
  parseAutoLaunchMentions, formatAutoLaunchMention, launchHarnessParameters,
  parseAgentRoutingRequirements, harnessParameterObservation } from "../dist/index.js";

const presets = JSON.parse(readFileSync(new URL("../src/agent-presets.json", import.meta.url)));

test("every registered harness shares future parameter tags, quoting and highlight spans", () => {
  for (const preset of presets.filter(p => p.id !== "custom")) {
    const body = `@${preset.id} param.future-speed:"very fast" fast:on task`;
    const [mention] = parseAutoLaunchMentions(body);
    assert.equal(mention.error, undefined, preset.id);
    assert.deepEqual(launchHarnessParameters(mention.tags), { "future-speed": "very fast", fast: "on" });
    assert.deepEqual(mention.conditions.map(c => body.slice(c.valueStart, c.end)), ['"very fast"', "on"]);
    assert.deepEqual(parseAutoLaunchMentions(formatAutoLaunchMention(mention.tags, true))[0].tags, mention.tags);
  }
});

test("malformed, repeated, privileged and reserved launch parameters fail closed", () => {
  for (const body of ["@auto fast:on param.fast:off", "@auto param.speed:", "@auto param.:fast",
    "@auto param.1speed:fast", "@auto param.approvalPolicy:never", "@auto param.model:large",
    `@auto param.${"a".repeat(65)}:fast`, "@auto param.networkAccess:enabled", "@auto param.autoApprove:on", "@auto param.yolo:on"]) {
    assert.ok(parseAutoLaunchMentions(body)[0]?.error, body);
  }
  const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, "on"]));
  assert.throws(() => parseHarnessParameterValues(tooMany));
  assert.throws(() => parseHarnessParameterValues({ speed: "a\ncommand" }));
  assert.throws(() => parseAgentRoutingRequirements({ model: "m", unattended: false,
    requiredCapabilities: [], parameters: { sandbox: "off" } }));
});

test("catalog replacement withdraws old choices and rejects executable metadata", () => {
  const catalog = parseHarnessParameters([{ id: "future-speed", label: "Speed", options: ["turbo", "steady"], currentValue: "steady" }]);
  validateHarnessParameterValues(catalog, { "future-speed": "turbo" });
  assert.throws(() => validateHarnessParameterValues([], { "future-speed": "turbo" }));
  assert.throws(() => validateHarnessParameterValues(catalog, { "future-speed": "invented" }));
  assert.deepEqual(parseHarnessParameters([]), []);
  for (const invalid of [[...catalog, ...catalog], [{ ...catalog[0], options: ["turbo", "turbo"] }],
    [{ ...catalog[0], currentValue: "missing" }], [{ ...catalog[0], command: "sh" }],
    [{ id: "sandbox", label: "Sandbox", options: ["off"] }]]) {
    assert.throws(() => parseHarnessParameters(invalid));
  }
});


test("registration observations cannot freshen stale catalogs or reveal an ungranted model", () => {
  const now = Date.now(), at = new Date(now - 1000).toISOString();
  const parameters = [{ id: "speed", label: "Speed", options: ["turbo"] }];
  const catalog = [...parameters, { id: "model", label: "Model", options: ["allowed", "private"] }];
  assert.deepEqual(harnessParameterObservation(catalog, at, "allowed", ["allowed"], now), { parameters, parameterModel: "allowed" });
  assert.equal(harnessParameterObservation(catalog, at, "private", ["allowed"], now), undefined);
  assert.equal(harnessParameterObservation(catalog, new Date(now - 86_400_000).toISOString(), "allowed", ["allowed"], now), undefined);
  assert.equal(harnessParameterObservation(catalog, new Date(now + 1000).toISOString(), "allowed", ["allowed"], now), undefined);
  assert.deepEqual(harnessParameterObservation([], at, undefined, ["allowed"], now), { parameters: [] });
});


test("cold observations defer validation and fast boolean aliases are canonical", () => {
  validateHarnessParameterValues(undefined, { speed: "turbo" });
  assert.throws(() => validateHarnessParameterValues([], { speed: "turbo" }));
  for (const [value, canonical] of [["true", "on"], ["false", "off"]]) {
    const mention = parseAutoLaunchMentions(`@claude fast:${value}`)[0];
    assert.equal(mention.error, undefined);
    assert.deepEqual(launchHarnessParameters(mention.tags), { fast: canonical });
  }
});

test("parameter kind is declared or inferred from an exact switch pair", () => {
  assert.equal(harnessParameterKind({ options: ["on", "off"] }), "boolean");
  assert.equal(harnessParameterKind({ options: ["False", "True"] }), "boolean");
  assert.equal(harnessParameterKind({ options: ["on", "off", "auto"] }), "enum");
  assert.equal(harnessParameterKind({ options: ["yes", "no"] }), "enum");
  assert.equal(harnessParameterKind({ options: ["yes", "no"], kind: "boolean" }), "boolean");
  assert.ok(harnessParameterEnabled("TRUE") && !harnessParameterEnabled("off") && !harnessParameterEnabled(undefined));
  assert.deepEqual(parseHarnessParameters([{ id: "fast", label: "Fast", options: ["on", "off"], kind: "boolean" }])[0].kind, "boolean");
  for (const kind of ["toggle", 1]) {
    assert.throws(() => parseHarnessParameters([{ id: "fast", label: "Fast", options: ["on", "off"], kind }]));
  }
  assert.throws(() => parseHarnessParameters([{ id: "speed", label: "Speed", options: ["a", "b", "c"], kind: "boolean" }]));
});

test("the catalog carries finite choices with provider labels, categories, notices and aliases", () => {
  const [tier, fast] = parseHarnessParameters([
    { id: "serviceTier", label: "Service tier", description: "Speed and price", category: "model_config", kind: "enum",
      options: ["priority", "default"], choices: [{ value: "priority", label: "Fast", description: "1.5x speed" }, { value: "default" }],
      currentValue: "priority" },
    { id: "fast", label: "Fast mode", kind: "boolean", options: ["on", "off"], currentValue: "on", notice: "cooldown", aliasOf: "serviceTier" },
  ]);
  assert.equal(harnessParameterValueLabel(tier, "priority"), "Fast");
  assert.equal(harnessParameterValueLabel(tier, "default"), "default");
  assert.equal(fast.notice, "cooldown");
  // A declared enum is never read as a switch, even with on/off values.
  const declared = { id: "x", label: "X", kind: "enum", options: ["on", "off"] };
  assert.equal(harnessParameterKind(declared), "enum");
  assert.equal(harnessParameterValue(declared, "true"), undefined);
  // Every switch accepts any on/off/true/false spelling, mapped to its own.
  const native = { id: "y", label: "Y", options: ["true", "false"] };
  assert.equal(harnessParameterValue(native, "ON"), "true");
  assert.equal(harnessParameterValue(native, "off"), "false");
  validateHarnessParameterValues([native], { y: "on" });
  assert.throws(() => validateHarnessParameterValues([declared], { x: "true" }));
  for (const invalid of [
    [{ id: "a", label: "A", options: ["1", "2"], choices: [{ value: "2" }, { value: "1" }] }],
    [{ id: "a", label: "A", options: ["1"], choices: [{ value: "1", run: "sh" }] }],
    [{ id: "a", label: "A", options: ["1"], category: "Mode!" }],
    [{ id: "a", label: "A", options: ["1"], aliasOf: "missing" }],
    [{ id: "a", label: "A", options: ["1"], aliasOf: "a" }],
    [{ id: "a", label: "A", options: [1, 2] }],
    [{ id: "a", label: "A", options: [["x"]] }],
    [{ id: "a", label: "A", options: [] }],
  ]) assert.throws(() => parseHarnessParameters(invalid), JSON.stringify(invalid));
});

test("the status-tag registry names each tag's icon and lists the parameters shown as tags", async () => {
  const { parameterTagRule, statusTagIcon } = await import("../dist/index.js");
  assert.equal(parameterTagRule("fast")?.label, "Fast");
  assert.equal(parameterTagRule("outputStyle"), undefined);
  assert.equal(statusTagIcon("parameter:fast"), "fast");
  assert.equal(statusTagIcon("Model"), "model");
  assert.equal(statusTagIcon("parameter:outputStyle"), undefined);
  assert.equal(statusTagIcon("mode"), undefined);
});
