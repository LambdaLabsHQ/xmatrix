const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  spaceAgentSetupCandidates,
  spaceAgentSetupState,
} = require("./space-agent-setup.ts");

function workspace(name) {
  return {
    path: `/Users/dev/${name}`,
    canonicalCwd: `/Users/dev/${name}`,
    displayName: name,
    hostId: "host-1",
    hostName: "macbook",
  };
}

function discovery(overrides) {
  return {
    presetId: "claude",
    displayName: "Claude Code",
    runtime: "claude",
    backend: "claude-print",
    runtimeAvailable: true,
    configDirs: ["/Users/dev/.claude"],
    workspaces: [workspace("xmatrix")],
    ...overrides,
  };
}

function input(overrides) {
  return {
    channelsLoaded: true,
    agentsLoaded: true,
    spaceAgentsUnreachable: false,
    spaceAgentCount: 0,
    desktopAvailable: true,
    discoveryAvailable: true,
    loadingDiscoveries: false,
    daemonStatus: { state: "running" },
    discoveries: [discovery()],
    ...overrides,
  };
}

test("an unfinished channel catalog cannot trigger agent setup", () => {
  assert.deepEqual(spaceAgentSetupState(input({ channelsLoaded: false })), { kind: "hidden" });
  assert.equal(spaceAgentSetupState(input()).kind, "ready-to-bind");
});

test("nothing is claimed until the registration read for this Space lands", () => {
  // A Space that does have agents renders with an empty registration list until its
  // read comes back, and that read is routinely slow. Counting zero registrations
  // then is not the same finding as a Space with no agent, so every panel that
  // asserts something about agents stays off until the read answers.
  assert.deepEqual(
    spaceAgentSetupState(input({ agentsLoaded: false })),
    { kind: "hidden" }
  );
  // Including the web path, which otherwise needs nothing but a missing bridge
  // to render the remote-machine panel.
  assert.deepEqual(
    spaceAgentSetupState(
      input({ agentsLoaded: false, desktopAvailable: false })
    ),
    { kind: "hidden" }
  );
  // And the local discovery spinner: it names this machine, for a Space that
  // may already be set up somewhere else entirely.
  assert.deepEqual(
    spaceAgentSetupState(
      input({
        agentsLoaded: false,
        loadingDiscoveries: true,
        discoveries: [],
      })
    ),
    { kind: "hidden" }
  );
});

test("a failed read reports the failure instead of going quiet", () => {
  // Silence would be honest about agents and silent about the reason, and a
  // human looking at an empty area concludes the Space is empty.
  assert.deepEqual(
    spaceAgentSetupState(
      input({ agentsLoaded: false, spaceAgentsUnreachable: true })
    ),
    { kind: "unreachable" }
  );
  // The failure outranks every local-machine branch: none of them can be
  // evaluated without knowing what the Space already has.
  assert.equal(
    spaceAgentSetupState(
      input({
        agentsLoaded: false,
        spaceAgentsUnreachable: true,
        desktopAvailable: false,
      })
    ).kind,
    "unreachable"
  );
  // A refresh that fails after a good read is still a failure to report, not a
  // Space that just lost its agents.
  assert.equal(
    spaceAgentSetupState(
      input({ spaceAgentsUnreachable: true, spaceAgentCount: 3 })
    ).kind,
    "unreachable"
  );
  // In flight is not failed: still waiting, with nothing to report yet.
  assert.deepEqual(
    spaceAgentSetupState(input({ agentsLoaded: false })),
    { kind: "hidden" }
  );
});

test("a Space that already has an Agent is not guided", () => {
  assert.deepEqual(spaceAgentSetupState(input({ spaceAgentCount: 1 })), {
    kind: "hidden",
  });
});

test("web and mobile fall back to the remote-machine path", () => {
  assert.deepEqual(spaceAgentSetupState(input({ desktopAvailable: false })), {
    kind: "no-local-machine",
  });
  assert.deepEqual(spaceAgentSetupState(input({ discoveryAvailable: false })), {
    kind: "no-local-machine",
  });
});

test("the spinner only shows before the first discovery result", () => {
  assert.deepEqual(
    spaceAgentSetupState(input({ loadingDiscoveries: true, discoveries: [] })),
    { kind: "discovering" }
  );
  const refreshing = spaceAgentSetupState(input({ loadingDiscoveries: true }));
  assert.equal(refreshing.kind, "ready-to-bind");
});

test("a runtime that cannot be executed is not offered", () => {
  const state = spaceAgentSetupState(
    input({ discoveries: [discovery({ runtimeAvailable: false })] })
  );
  assert.deepEqual(state, { kind: "no-runtime" });
});

test("a stopped daemon still reports what was found", () => {
  const state = spaceAgentSetupState(input({ daemonStatus: { state: "stopped" } }));
  assert.equal(state.kind, "daemon-stopped");
  assert.equal(state.candidates.length, 1);
});

test("a missing daemon status is not treated as running", () => {
  assert.equal(spaceAgentSetupState(input({ daemonStatus: null })).kind, "daemon-stopped");
  assert.equal(
    spaceAgentSetupState(input({ daemonStatus: undefined })).kind,
    "daemon-stopped"
  );
});

test("a candidate reports how many directories the runtime knows, never which", () => {
  // Directory names come from this machine's runtime history and span every
  // organisation this person works for; a Space must not display them.
  const [candidate] = spaceAgentSetupCandidates([discovery()]);
  assert.equal(candidate.knownWorkspaceCount, 1);
  assert.equal("recentWorkspaces" in candidate, false);
});

test("candidates are ranked by how much launch context they carry", () => {
  const candidates = spaceAgentSetupCandidates([
    discovery({ presetId: "codex", displayName: "Codex", workspaces: [] }),
    discovery({
      presetId: "claude",
      displayName: "Claude Code",
      workspaces: [workspace("a"), workspace("b")],
    }),
  ]);
  assert.deepEqual(
    candidates.map((candidate) => candidate.presetId),
    ["claude", "codex"]
  );
});

test("a runtime with no config directory is reported as never used", () => {
  const [candidate] = spaceAgentSetupCandidates([discovery({ configDirs: [] })]);
  assert.equal(candidate.usedBefore, false);
});
