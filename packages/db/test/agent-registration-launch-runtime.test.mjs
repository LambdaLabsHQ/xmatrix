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
  // A launch with no workspace runs in a managed directory only on a daemon that declares it.
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

test('a launch adds exactly the access grant of its confirmed mode', () => {
  const fields = (harness, launch) => registrationLaunchSpawnFields(launch, harness);
  // No confirmed mode is the full access every launch had: the grant, and its
  // args in the argv a daemon that predates the grant starts.
  const claude = fields('claude');
  assert.deepEqual(claude.access, { mode: 'full', args: ['--dangerously-skip-permissions'], env: {}, session: {}, approvesRequests: true });
  assert.deepEqual(claude.runtimeArgs, ['--dangerously-skip-permissions']);
  // A launch that declared its own arguments before its owner was asked
  // starts with exactly those: without the flag it never had full access, and
  // its grant says so rather than adding one.
  const bare = fields('claude', { runtime: 'claude', runtimeArgs: ['--model', 'opus'] });
  assert.deepEqual(bare.runtimeArgs, ['--model', 'opus']);
  assert.deepEqual(bare.access.args, []);
  assert.deepEqual(fields('claude', { runtime: 'claude', runtimeArgs: ['--model', 'opus'], access: 'full' }).runtimeArgs,
    ['--model', 'opus', '--dangerously-skip-permissions']);
  assert.deepEqual(fields('antigravity', { runtime: 'agy', runtimeArgs: ['acp', '--verbose'], backend: 'acp' }).access.args, []);
  // One saved with the flag keeps it where it was, and loses it once its
  // owner chooses `ask`.
  const saved = { runtime: 'claude', runtimeArgs: ['--dangerously-skip-permissions', '--model', 'opus'] };
  assert.deepEqual(fields('claude', saved).runtimeArgs, ['--dangerously-skip-permissions', '--model', 'opus']);
  const asked = fields('claude', { ...saved, access: 'ask' });
  assert.deepEqual(asked.runtimeArgs, ['--model', 'opus']);
  assert.deepEqual(asked.access, { mode: 'ask', args: [], env: {}, session: {}, approvesRequests: false });
  // The generic ACP backend takes them in its ACP argv, and the bridge's
  // answer to permission requests is part of the grant.
  const antigravity = fields('antigravity');
  assert.deepEqual(antigravity.agentAcpArgs, ['acp', '--dangerously-skip-permissions']);
  assert.equal(antigravity.runtimeArgs, undefined);
  assert.equal(antigravity.access.approvesRequests, true);
  assert.equal(fields('antigravity', { runtime: 'agy', runtimeArgs: [], backend: 'acp', access: 'ask' }).access.approvesRequests, false);
  assert.deepEqual(fields('antigravity', { runtime: 'agy', runtimeArgs: [], backend: 'acp', access: 'ask' }).agentAcpArgs, ['acp']);
  // A harness xMatrix adds no parameter to still has its requests answered.
  assert.deepEqual(fields('opencode').access, { mode: 'full', args: [], env: {}, session: {}, approvesRequests: true });
  // An older daemon adds Grok's flag itself; a second one must not reach it.
  const grok = fields('grok');
  assert.deepEqual(grok.access.args, ['--always-approve']);
  assert.equal(grok.runtimeArgs, undefined);
  assert.deepEqual(fields('codex').access.session, { sandbox: 'danger-full-access', approvalPolicy: 'never' });
  assert.deepEqual(fields('deepseek').access.env, { DSH_PERMISSION_MODE: 'danger-full-access' });
});
