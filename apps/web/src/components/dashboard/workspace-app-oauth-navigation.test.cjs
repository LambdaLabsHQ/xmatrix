const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "workspace-fleet-views.tsx"), "utf8");
const callbacks = source.split("useEffect(() => {").slice(1).map((part) => part.split("\n  },")[0]);

function consumeCallback(search, providerParameter) {
  const initialItem = providerParameter === "github" ? "notion" : "github";
  const location = { href: `https://xmatrix.test/app/space-1/apps?keep=value&item=${initialItem}&${search}#detail` };
  let notice;
  const window = {
    location,
    history: {
      state: { fixture: true },
      replaceState(state, title, destination) {
        assert.deepEqual(state, { fixture: true });
        location.href = new URL(destination, location.href).toString();
      },
    },
  };
  const effect = callbacks.find((body) => body.includes(`searchParams.get("${providerParameter}")`));
  vm.runInNewContext(`(() => {${effect}\n})()`, {
    URL, window,
    connectors: [{ id: "notion", name: "Notion" }],
    setSetupNotice(value) { notice = value; },
    // useToolItem stores the selected detail in the URL, rather than local component state.
    setSelectedConnectorId(id) {
      const next = new URL(location.href);
      next.searchParams.set("item", id);
      window.history.replaceState(window.history.state, "", next);
    },
  });
  return { url: new URL(location.href), notice };
}

for (const outcome of ["connected", "failed"]) {
  test(`OAuth ${outcome} keeps the returning provider detail after consuming callback parameters`, () => {
    const { url, notice } = consumeCallback(`connector=notion&oauth=${outcome}`, "oauth");
    assert.equal(url.searchParams.get("item"), "notion");
    assert.equal(url.searchParams.get("oauth"), null);
    assert.equal(url.searchParams.get("connector"), null);
    assert.equal(url.searchParams.get("keep"), "value");
    assert.equal(url.pathname, "/app/space-1/apps");
    assert.equal(url.hash, "#detail");
    assert.equal(notice.tone, outcome === "connected" ? "success" : "warning");
    assert.match(notice.message, /Notion/);
  });
}

/** Runs the Apps view's GitHub return effect with what /connect/github kept for the tab. */
function consumeGitHubReturn(outcome) {
  let notice;
  let selected = "notion";
  const effect = callbacks.find((body) => body.includes("takeGitHubConnectOutcome()"));
  vm.runInNewContext(`(() => {${effect}\n})()`, {
    takeGitHubConnectOutcome: () => outcome,
    setSetupNotice(value) { notice = value; },
    setSelectedConnectorId(id) { selected = id; },
  });
  return { selected, notice };
}

for (const outcome of ["connected", "updated", "authorized"]) {
  test(`GitHub ${outcome} selects GitHub and says so`, () => {
    const { selected, notice } = consumeGitHubReturn(outcome);
    assert.equal(selected, "github");
    assert.equal(notice.tone, "success");
  });
}

test("no GitHub return leaves the Apps view as it was", () => {
  const { selected, notice } = consumeGitHubReturn(undefined);
  assert.equal(selected, "notion");
  assert.equal(notice, undefined);
});
