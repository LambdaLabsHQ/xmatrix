const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function functions(file, names) {
  const source = fs.readFileSync(path.join(__dirname, file), "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
    .map(node => node.getText(parsed)).join("\n");
}
const exportsForTest = {};
const source = functions("workspace-shell-presence.ts", ["memberPresence", "presenceStatusLabel"]) + "\n" +
  functions("workspace-admin-views.tsx", ["mergeChannelMemberPresencePreferringQuotas"]);
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
  { exports: exportsForTest });

test("missing Human presence is unknown, while a complete empty map is offline", () => {
  const unknown = exportsForTest.memberPresence({ id: "channel" }, "user:viewer");
  assert.equal(unknown.status, undefined);
  assert.equal(exportsForTest.presenceStatusLabel(unknown), "Status unknown");
  assert.equal(exportsForTest.memberPresence({ memberPresence: {} }, "user:viewer").status, "offline");
});

test("unavailable catalog presence preserves hydrated state and later full snapshots replace it", () => {
  const online = { "user:viewer": { kind: "user", status: "online" } };
  const merge = exportsForTest.mergeChannelMemberPresencePreferringQuotas;
  assert.equal(merge(online, undefined), online);
  assert.equal(exportsForTest.memberPresence({ memberPresence: online }, "user:viewer").status, "online");
  assert.equal(Object.keys(merge(online, {})).length, 0);
  assert.equal(exportsForTest.memberPresence({ memberPresence: merge(online, {}) }, "user:viewer").status, "offline");
});
