import assert from "node:assert/strict";
import { Hono } from "hono";
import * as protocol from "@xmatrix/protocol";
import * as db from "../../db/dist/index.js";
import { integration } from "../../db/test/postgres-database.fixture.mjs";
import { spaceSecretFixture } from "../../db/test/space-secret-postgres.fixture.mjs";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { registrationRepositoryCatalog } from "../src/registration-repository-catalog.ts";
import * as runBinding from "../src/github-repository-token-run-binding.ts";

// Repository role tests cannot catch callers that omit `use`. Exercise the HTTP
// routes and selection helpers with real PostgreSQL authorization. Authentication,
// unrelated workspace discovery and upstream GitHub responses are fixture edges.
const management = await compileCommonJsSourceModule(new URL("../src/index-routes-auth-space-management.ts", import.meta.url));
const apps = await compileCommonJsSourceModule(new URL("../src/apps.ts", import.meta.url));
const launch = await compileCommonJsSourceModule(new URL("../src/launch-target-repositories.ts", import.meta.url));
const routes = await compileCommonJsSourceModule(new URL("../src/index-routes-auth-space.ts", import.meta.url));
const privateRepository = { value: "org/private-synthetic", private: true, description: "SYNTHETIC-PRIVATE-REPO-METADATA" };

async function withFixture(run) {
  const source = await spaceSecretFixture();
  const { client, ids } = source;
  const database = db.createAuthorityDatabase({ connectionString: process.env.XMATRIX_TEST_POSTGRES_URL,
    shardId: "shard-0", applicationName: "connector-member-authorization-test",
    statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000 });
  try {
    await client.query(`INSERT INTO data.app_connector_connections
      (space_id,connection_id,version,provider_id,provider_name,status,auth_mode,scopes_json,secret_refs_json,
       capabilities_json,channel_ids_json,created_by,search_rank_sequence,created_at,updated_at,metadata_json)
      VALUES ($1,$1||':github',1,'github','GitHub','configured','api-token','[]','[]','[]','[]',$2,
        $1||':github',now(),now(),'{}')`, [ids.space, ids.admin]);
    await client.query(`UPDATE data.channels SET metadata_json=jsonb_build_object('intakeOf',$2::text)
      WHERE channel_id=$1`, [ids.channel, ids.owner]);
    const appAPI = apps(name => ({ "@xmatrix/db": db, "@xmatrix/protocol": protocol,
      "./postgres-authority-http": { postgresAuthorityDatabase: () => database } })[name] ?? {});
    const calls = { mint: 0, launch: 0, completion: 0, inference: 0 };
    const imports = {
      "@xmatrix/protocol": protocol, "@xmatrix/db": db,
      "./github-repository-token-run-binding": runBinding,
      "./app-connectors": {
        resolveAppConnectorCompletionOptions: async () => {
          calls.completion++;
          return [{ id: "synthetic-private", value: "private-synthetic", label: "SYNTHETIC-PRIVATE-REPO-METADATA" }];
        },
        mintGitHubRepositoryToken: async () => { calls.mint++; return { token: "synthetic-scoped-token" }; },
      },
      "./index-shared": {
        requireMachineDaemonAuth: async () => ({ ownerUserId: ids.owner, machineId: ids.machine }),
        requireAuth: async () => ({ id: ids.owner }),
        jsonErrors: async (context, work) => {
          try { return await work(); }
          catch (error) { return context.json({ error: error.code ?? "failed" }, error.status ?? 500); }
        },
      },
      "./spaces": { getChannel: async () => ({ channel: { spaceId: ids.space } }),
        getSpace: async () => ({ space: { id: ids.space } }) },
      "./postgres-workspace-authority": { workspaceRepository: () => ({}), listOwnerWorkspaces: async () => [] },
      "./launch-target-repositories": launch(name => ({
        "./app-connectors": { spaceLaunchTargetRepositories: async () => { calls.launch++; return [privateRepository]; } },
        "./apps": appAPI,
      })[name] ?? {}),
      "./apps": appAPI,
      "./runtime": { runtimeRepository: () => ({ getRun: async () => ({ run: { status: "running", channelId: ids.channel,
        metadata: { executionKey: source.run.executionKey, machineId: ids.machine, remoteRepo: "org/repo" } } }) }) },
      "./index-routes-auth-space-instances": { registerIndexRoutesAuthSpaceInstances() {} },
      "./index-routes-auth-space-management": { registerIndexRoutesAuthSpaceManagement(app) {
        management(name => imports[name] ?? {}).registerIndexRoutesAuthSpaceManagement(app);
      } },
      "./index-routes-machine-executions": { registerMachineExecutionRoutes() {} },
      "./index-routes-reply-recovery": { registerReplyRecoveryRoutes() {} },
    };
    const app = new Hono();
    routes(name => imports[name] ?? {}).registerIndexRoutesAuthSpace(app);
    await run({ calls,
      role: role => client.query("UPDATE data.space_members SET role=$3 WHERE space_id=$1 AND user_id=$2", [ids.space, ids.owner, role]),
      launch: () => app.request(`/api/spaces/${ids.space}/launch-targets`, {}, {}),
      completion: () => app.request(`/api/spaces/${ids.space}/app-connections/github/completion?source=github-repositories&parent=org`, {}, {}),
      inference: () => registrationRepositoryCatalog({}, database, ids.space, async () => {
        calls.inference++; return [privateRepository];
      })(ids.owner),
      token: bound => app.request(protocol.HUB_ROUTES.machine_daemon_github_repository_token, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ channelId: ids.channel, repository: "org/repo",
          ...(bound ? { runId: ids.run, executionKey: source.run.executionKey } : {}) }) },
      { GITHUB_REPOSITORY_TOKEN_LEGACY_UNBOUND_ENABLED: "true" }),
    });
  } finally {
    try { await client.query("DELETE FROM data.app_connector_connections WHERE space_id=$1", [ids.space]); }
    finally { await database.close?.(); await source.close(); }
  }
}

integration("repository-token HTTP refuses a reader on both bound and legacy routes before any mint", async () => {
  await withFixture(async f => {
    for (const bound of [false, true]) {
      await f.role("member");
      assert.equal((await f.token(bound)).status, 200);
      const before = f.calls.mint;
      for (const role of ["participant", "viewer"]) {
        await f.role(role);
        const response = await f.token(bound);
        assert.equal(response.status, 403, `${bound ? "Run" : "legacy"} ${role}`);
        assert.equal((await response.json()).error, "github_repository_token_requires_member");
        assert.equal(f.calls.mint, before, "no provider credential mint after demotion");
      }
    }
  });
});

integration("launch-target HTTP keeps private repository names and descriptions with current members", async () => {
  await withFixture(async f => {
    assert.match(await (await f.launch()).text(), /SYNTHETIC-PRIVATE-REPO-METADATA/u);
    const before = f.calls.launch;
    for (const role of ["participant", "viewer"]) {
      await f.role(role);
      const response = await f.launch();
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.repos, []);
      assert.equal(body.repoStatus, "unavailable");
      assert.equal(body.repoStatusDetail, "github_repositories_require_member");
      assert.equal(f.calls.launch, before, "the reader is refused before fetching the private catalog");
    }
  });
});

integration("completion HTTP checks current app-use authority before fetching the provider catalog", async () => {
  await withFixture(async f => {
    assert.match(await (await f.completion()).text(), /SYNTHETIC-PRIVATE-REPO-METADATA/u);
    const before = f.calls.completion;
    for (const role of ["participant", "viewer"]) {
      await f.role(role);
      const response = await f.completion();
      assert.equal(response.status, 403);
      assert.doesNotMatch(await response.text(), /private-synthetic|SYNTHETIC-PRIVATE-REPO-METADATA/u);
      assert.equal(f.calls.completion, before, "no upstream catalog for a reader");
    }
  });
});

integration("inference never fetches private repository metadata for a viewer or participant", async () => {
  await withFixture(async f => {
    assert.deepEqual((await f.inference()).repositories, ["org/private-synthetic"]);
    const before = f.calls.inference;
    for (const role of ["participant", "viewer"]) {
      await f.role(role);
      assert.equal(await f.inference(), undefined);
      assert.equal(f.calls.inference, before, "no provider read before inference");
    }
  });
});
