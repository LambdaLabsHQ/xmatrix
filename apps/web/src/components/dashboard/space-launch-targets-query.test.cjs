const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { QueryClient, QueryObserver } = require("@tanstack/react-query");
const { spaceLaunchTargetsQuery } = require("./space-launch-targets-query.ts");
const { invalidateWorkspaceResources } = require("./workspace-resource-push.ts");

test("entering a Space shares one catalog read across composers until a change or reconnect", async t => {
  const original = globalThis.fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(() => { globalThis.fetch = original; client.clear(); });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ spaceId: "space", repoStatus: "authorized", repos: [{ value: `org/repo-${calls}` }], workspaces: [] });
  };
  const options = () => spaceLaunchTargetsQuery("user", "token", "space");
  // The shell reads with no draft. Each composer observes that same query.
  const first = await client.fetchQuery(options());
  for (let mount = 0; mount < 3; mount++) {
    const observer = new QueryObserver(client, options());
    const stop = observer.subscribe(() => {});
    assert.deepEqual(await client.fetchQuery(options()), first);
    stop();
  }
  assert.equal(calls, 1);
  await invalidateWorkspaceResources(client, { resource: "launch_targets", spaceId: "other-space" });
  assert.deepEqual(await client.fetchQuery(options()), first);
  assert.equal(calls, 1, "another Space's event cannot invalidate this one");
  await invalidateWorkspaceResources(client, { resource: "launch_targets", spaceId: "space" });
  assert.equal((await client.fetchQuery(options())).repos[0].value, "org/repo-2");
  await invalidateWorkspaceResources(client); // Existing socket reconnect recovery.
  assert.equal((await client.fetchQuery(options())).repos[0].value, "org/repo-3");
  const otherUser = spaceLaunchTargetsQuery("other-user", "token", "space");
  await client.fetchQuery(otherUser);
  assert.equal(calls, 4, "private candidates never cross the query identity boundary");
});

test("a GitHub change during the first preload retires its answer before refreshing", async t => {
  const original = globalThis.fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let finishOld, oldSignal, calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    if (calls === 1) {
      oldSignal = init.signal;
      return new Promise(resolve => { finishOld = () => resolve(Response.json({ spaceId: "space", repos: ["old"] })); });
    }
    return Response.json({ spaceId: "space", repos: ["new"] });
  };
  const options = spaceLaunchTargetsQuery("user", "token", "space");
  const observer = new QueryObserver(client, options);
  const stop = observer.subscribe(() => {});
  t.after(() => { finishOld(); stop(); client.clear(); globalThis.fetch = original; });
  await invalidateWorkspaceResources(client, { resource: "launch_targets", spaceId: "space" });
  assert.equal(oldSignal.aborted, true);
  assert.equal(calls, 2);
  finishOld();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(client.getQueryData(options.queryKey).repos, ["new"]);
});
