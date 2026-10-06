import assert from 'node:assert/strict';
import test from 'node:test';

import { registrationLaunchSpawnFields } from '../dist/agent-registration-launch.js';

test('a harness key is never exec\'d: the preset runtime or the declared launch is', () => {
  assert.equal(registrationLaunchSpawnFields(undefined, 'claude_code').runtime, 'claude');
  assert.equal(registrationLaunchSpawnFields({ runtime: '/opt/bin/claude', runtimeArgs: [] }, 'claude_code').runtime, '/opt/bin/claude');
  assert.throws(() => registrationLaunchSpawnFields(undefined, 'no-such-harness'), { code: 'registration_runtime_unknown' });
});

test('a declared launch naming a harness key execs its preset launcher', async () => {
  // A declared runtime such as `claude_code` names the harness, not an executable.
  for (const [declared, executable] of [['claude_code', 'claude'], ['claude', 'claude'], ['cursor', 'cursor-agent'], ['pi', 'pi-acp']]) {
    assert.equal(registrationLaunchSpawnFields({ runtime: declared, runtimeArgs: [] }, 'claude').runtime, executable, declared);
  }
});

test('a declared runtime that is no preset launcher still carries the harness preset to the daemon', async () => {
  const { agentHarnessSpec } = await import('@xmatrix/protocol');
  const fields = registrationLaunchSpawnFields({ runtime: '/Users/owner/.local/share/codex-wrapper', runtimeArgs: [] }, 'codex');
  assert.equal(fields.agentPresetId, 'codex');
  // The Hub derives the spawn's harness spec from these fields; the daemon
  // refuses a registered launch whose spec is missing or names another harness.
  assert.equal(agentHarnessSpec(fields.agentPresetId, fields.runtime)?.id, 'codex');
  assert.equal(agentHarnessSpec(undefined, fields.runtime), undefined);
});

test('a registration is offered only where preparation can route its launch', async () => {
  const { routableRegistrationLaunch } = await import('../dist/agent-registration-launch.js');
  const daemon = (host, ...capabilities) => ({ hostname: host, capabilities_json: ['registration_launch_v3', ...capabilities] });
  const repo = { workspaceReferences: ['repo:o/r'], registeredWorkspaceIds: new Set(), managedWorkspace: false };
  // No routable daemon (offline or pre-v3): never a candidate.
  assert.equal(routableRegistrationLaunch([], { ...repo, runtimeDefaultOnly: false }), undefined);
  // The runtime default needs a daemon that accepts an omitted model.
  assert.equal(routableRegistrationLaunch([daemon('h')], { ...repo, runtimeDefaultOnly: true }), undefined);
  assert.deepEqual(routableRegistrationLaunch([daemon('h', 'registration_optional_model_v1')],
    { ...repo, runtimeDefaultOnly: true })?.workspaceReferences, ['repo:o/r']);
  // Exactly one daemon serves the Machine; registered directories follow its identity.
  const both = { workspaceReferences: ['repo:o/r', 'ws-a', 'ws-b'], managedWorkspace: false, runtimeDefaultOnly: false,
    registeredWorkspaceIds: new Set(['ws-a', 'ws-b']) };
  assert.equal(routableRegistrationLaunch([daemon('h1'), daemon('h2')], both), undefined);
  assert.deepEqual(routableRegistrationLaunch([daemon('h1')], both)?.workspaceReferences, ['repo:o/r', 'ws-a', 'ws-b']);
  // A management launch runs in a managed directory only on a daemon that declares it.
  const managed = { workspaceReferences: [], registeredWorkspaceIds: new Set(), managedWorkspace: true, runtimeDefaultOnly: false };
  assert.equal(routableRegistrationLaunch([daemon('h')], managed), undefined);
  assert.ok(routableRegistrationLaunch([daemon('h', 'registration_managed_v1')], managed));
});

test('a route refusal names an offline daemon, but keeps the original cause otherwise', async () => {
  const { registrationRouteRefusal } = await import('../dist/agent-registration-errors.js');
  const fallback = 'registration_workspace_or_daemon_unavailable';
  const route = { ownerUserId: 'owner', machineId: 'machine', hostId: 'host' };
  const tx = (workspace, daemons) => ({ query: async ({ name, values }) => {
    if (name === 'registration_route_refusal_workspace_v2') return workspace ? [workspace] : [];
    assert.deepEqual(values, ['owner', 'machine']);
    return [daemons];
  } });
  const refusal = async (workspace, daemons, input = route) =>
    (await registrationRouteRefusal(tx(workspace, daemons), fallback, input)).code;
  assert.equal(await refusal(undefined, { online: '0', known: '1' }), 'registration_daemon_offline');
  assert.equal(await refusal(undefined, { online: '1', known: '1' }), fallback, 'online but lacking a capability');
  assert.equal(await refusal(undefined, { online: '0', known: '0' }), fallback, 'no daemon was ever registered');
  const workspaceRoute = { ownerUserId: 'owner', machineId: 'machine', workspaceId: 'workspace' };
  assert.equal(await refusal({ hostname: 'host' }, { online: '0', known: '1' }, workspaceRoute), 'registration_daemon_offline');
  assert.equal(await refusal(undefined, { online: '0', known: '1' }, workspaceRoute), fallback, 'the Workspace is not registered');
});
