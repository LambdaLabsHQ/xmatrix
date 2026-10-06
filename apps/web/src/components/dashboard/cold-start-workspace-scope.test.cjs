const assert = require("node:assert/strict");
const test = require("node:test");
const { loadWorkspaceShellModuleMap, loadShellFunctions } = require("./workspace-shell-source-fixture.cjs");

const shellModules = loadWorkspaceShellModuleMap(__dirname);

// Extract and run the real functions, so this fails on behaviour rather than on
// how the precedence chain happens to be spelled.
const { resolveCurrentSpaceId, spacesAuthorityReady } = loadShellFunctions(shellModules, [
  "resolveCurrentSpaceId",
  "spacesAuthorityReady",
]);

const TEAM = { id: "space-team", name: "Team" };
const OTHER = { id: "space-other", name: "Other" };

function resolve(overrides) {
  return resolveCurrentSpaceId({
    pendingExplicitSpaceId: null,
    routeSpaceId: null,
    workingSpaceId: null,
    selectedChannelSpaceId: null,
    spaces: [],
    spacesLoaded: false,
    ...overrides,
  });
}

/**
 * The reported bug: the durable channel catalog paints before /spaces answers,
 * and the channel list renders every Space at once whenever it has no Space id.
 * The localStorage mirror is the only thing that knows the answer that early.
 */
test("the cold-start window scopes to the cached working workspace", () => {
  assert.equal(
    resolve({ spaces: [], spacesLoaded: false, workingSpaceId: "space-team" }),
    "space-team"
  );
});

/**
 * An authoritative empty list is still an answer. Keying the window on
 * `spaces.length` instead of `spacesLoaded` left this case true forever, which
 * pinned the shell to a Space id the user can no longer reach and held the
 * header in its pending placeholder for the rest of the session.
 */
test("an authoritative empty workspace list retires the cached mirror", () => {
  assert.equal(
    resolve({ spaces: [], spacesLoaded: true, workingSpaceId: "space-removed" }),
    null
  );
});

test("a workspace list that loaded empty does not keep the header pending", () => {
  // currentSpacePending is `Boolean(currentSpaceId) && !currentSpace`. A null id
  // is the genuine no-workspace state, so the header resolves instead of
  // waiting for a record that is never going to arrive.
  const currentSpaceId = resolve({
    spaces: [],
    spacesLoaded: true,
    workingSpaceId: "space-removed",
  });
  const spaces = [];
  const currentSpace = spaces.find((space) => space.id === currentSpaceId) || null;
  assert.equal(Boolean(currentSpaceId) && !currentSpace, false);
});

test("a mirror the loaded list does not contain never wins", () => {
  // Removed from that Space but still in others: fall to the first real one
  // rather than to an id no loaded Space matches.
  assert.equal(
    resolve({ spaces: [TEAM, OTHER], spacesLoaded: true, workingSpaceId: "space-removed" }),
    TEAM.id
  );
});

test("a mirror the loaded list contains wins over the first workspace", () => {
  assert.equal(
    resolve({ spaces: [TEAM, OTHER], spacesLoaded: true, workingSpaceId: OTHER.id }),
    OTHER.id
  );
});

test("an explicit switch outranks route, mirror and first workspace", () => {
  assert.equal(
    resolve({
      spaces: [TEAM, OTHER],
      spacesLoaded: true,
      pendingExplicitSpaceId: OTHER.id,
      routeSpaceId: TEAM.id,
      workingSpaceId: TEAM.id,
    }),
    OTHER.id
  );
});

test("an explicit switch the loaded list does not contain is ignored", () => {
  assert.equal(
    resolve({
      spaces: [TEAM],
      spacesLoaded: true,
      pendingExplicitSpaceId: "space-unknown",
      routeSpaceId: TEAM.id,
    }),
    TEAM.id
  );
});

test("the route outranks the mirror and the selected channel", () => {
  assert.equal(
    resolve({
      spaces: [TEAM, OTHER],
      spacesLoaded: true,
      routeSpaceId: OTHER.id,
      workingSpaceId: TEAM.id,
      selectedChannelSpaceId: TEAM.id,
    }),
    OTHER.id
  );
});

test("the selected channel scopes when nothing above it applies", () => {
  assert.equal(
    resolve({
      spaces: [TEAM, OTHER],
      spacesLoaded: true,
      workingSpaceId: "space-removed",
      selectedChannelSpaceId: OTHER.id,
    }),
    OTHER.id
  );
});

test("a first-ever launch with no mirror stays unscoped", () => {
  // No cached workspace and nothing loaded yet: there is nothing to scope to,
  // and the caller must not invent one.
  assert.equal(resolve({ spaces: [], spacesLoaded: false, workingSpaceId: null }), null);
});

test("an account with no workspaces at all stays unscoped", () => {
  assert.equal(resolve({ spaces: [], spacesLoaded: true, workingSpaceId: null }), null);
});

/*
 * Authority identity. The workspace load effect re-enters on the focus and
 * visibility JWT mint as well as on a real user change, so keying authority to
 * the token reopened the cold-start mirror window on every rotation. These
 * assert the identity predicate alone — what the resolver then does with a
 * surviving `spaces` list is the layer below.
 */
test("a token rotation for the same user keeps workspace authority", () => {
  assert.equal(spacesAuthorityReady("user-a", "user-a"), true);
});

test("switching users retires the previous user's workspace authority", () => {
  assert.equal(spacesAuthorityReady("user-a", "user-b"), false);
});

test("authority is never ready before a load lands or after sign-out", () => {
  assert.equal(spacesAuthorityReady(null, "user-a"), false);
  // Signed out: a null on both sides must not read as "matching".
  assert.equal(spacesAuthorityReady(null, null), false);
  assert.equal(spacesAuthorityReady("user-a", null), false);
});

test("a token rotation cannot revive a mirror an empty list retired", () => {
  // The regression this closes: rotation used to drop authority, which put an
  // authoritatively-empty account back into the cold-start window until the
  // next /spaces answered.
  const readyAcrossRotation = spacesAuthorityReady("user-a", "user-a");
  assert.equal(
    resolve({ spaces: [], spacesLoaded: readyAcrossRotation, workingSpaceId: "space-removed" }),
    null
  );
});

test("a retired authority closes the mirror fallback without claiming the list is empty", () => {
  // user A -> user B, before B's own load lands: A's `spaces` is still in state
  // (clearing it is separate, pre-existing behaviour). The only claim here is
  // that the cached mirror is not what scopes the shell — the surviving list is.
  const ready = spacesAuthorityReady("user-a", "user-b");
  assert.equal(ready, false);
  assert.equal(
    resolve({ spaces: [TEAM], spacesLoaded: ready, workingSpaceId: "space-mirror-of-a" }),
    TEAM.id
  );
});
