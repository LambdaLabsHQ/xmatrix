import { loadCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hub = join(dirname(fileURLToPath(import.meta.url)), "..");
const classes = {
  RelaySpaceRootAuthority: "relay-space-root",
  RelaySpaceMembershipAuthority: "relay-space-membership",
  RelayChannelCatalogAuthority: "relay-channel-catalog",
  RelayAgentAppPolicyAuthority: "relay-agent-app-policy",
  RelayTraceAccessAuthority: "relay-trace-access",
  RelayTraceAccessLocator: "relay-trace-access-locator",
  RelayTraceAccessUserIndex: "relay-trace-access-user-index",
  RelayUserPreferenceAuthority: "relay-user-preference",
  RelaySchedulerAuthority: "relay-scheduler-authority",
  RelayProjectionAuthorizationAuthority: "relay-projection-authorization",
};
/** Still bound in production, so only their behaviour is checked here. */
const boundShells = [
  "RelayScopedControlAuthority", "RelayGlobalDirectoryAuthority", "RelaySpaceCapacityAuthority",
  "RelayControlPlaneDirectory", "RelayChannelFamilyDirectory", "RelayChannelFamilyData",
  "RelayRankAuthorityDirectory", "RelayAgentAppPolicyLocator", "RelaySpaceProjection",
];

async function loadNamespaces() {
  const require = (name) => {
    assert.equal(name, "cloudflare:workers", "retained shells must not load storage collaborators");
    return { DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } };
  };
  return loadCommonJsSourceModule(join(hub, "src/retained-fact-namespaces.ts"), require);
}

test("retained fact namespaces never touch storage, even on repeated fetches or stale alarms", async () => {
  const namespaces = await loadNamespaces();
  const forbidden = new Proxy({}, {
    get(_target, key) { assert.fail(`retired authority touched ${String(key)}`); },
  });
  for (const name of [...Object.keys(classes), ...boundShells]) {
    const object = new namespaces[name](forbidden, forbidden);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await object.fetch(new Request("https://retired.invalid/", {
        method: "POST", body: "caller-supplied import or activation data",
      }));
      assert.equal(response.status, 410, name);
      assert.equal(await response.text(), "Durable Object fact authority is retired");
      await object.alarm();
    }
    for (const rpc of ["exportClonePage", "importClonePage", "resetClone", "cloneSchema",
      "prepare", "activate", "beginShadow", "readMember", "readCreationPolicy", "listConnections", "getConnection", "readChannel",
      "requestAuthoritativeGrant", "authorizeAuthoritativeScopes", "applySnapshot", "listSnapshots"]) {
      assert.equal(object[rpc], undefined, `${name} must not expose ${rpc}`);
    }
  }
});

test("retained class identities and migration history survive implementation removal", async () => {

  for (const [name, prefix] of Object.entries(classes)) {
    if (["RelaySpaceRootAuthority", "RelayUserPreferenceAuthority",
      "RelaySchedulerAuthority", "RelayProjectionAuthorizationAuthority",
      "RelaySpaceMembershipAuthority", "RelayChannelCatalogAuthority", "RelayAgentAppPolicyAuthority",
      "RelayTraceAccessAuthority", "RelayTraceAccessUserIndex"].includes(name)) {
      await assert.rejects(access(join(hub, `src/${prefix}-schema.ts`)));
    }
    const production = await readFile(join(hub, "wrangler.toml"), "utf8");
    assert.ok(!production.includes(`class_name = "${name}"`), `${name} is unbound`);
    assert.ok(!production.includes(`deleted_classes = ["${name}"]`), "no physical class deletion");
  }
});
