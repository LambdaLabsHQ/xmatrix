import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { ControlError } from '@xmatrix/db';
import { compileCommonJsSourceModule } from './support/commonjs-source-module.mjs';
import { APP_CONNECTOR_PROVIDER_MANIFESTS } from '../../protocol/src/app-connector-manifests.ts';
import * as oauth from '../src/connectors/oauth.ts';
import { HUB_ROUTES } from '../../protocol/src/authority-foundation.ts';
import { stubFetchResponses } from './support/fetch-responses.mjs';

const route = await compileCommonJsSourceModule(new URL('../src/index-routes-connector-oauth.ts', import.meta.url));
const appId = '123456789012345678', guildId = '223456789012345678', userId = '323456789012345678';
const env = { CONNECTOR_DISCORD_CLIENT_ID: appId, CONNECTOR_DISCORD_CLIENT_SECRET: 'fixture-client', CONNECTOR_DISCORD_BOT_TOKEN: 'fixture-bot',
  HUB_URL: 'https://hub.test', APP_URL: 'https://xmatrix.test' };
function fixture() {
  const calls = []; const state = { agent: false, denied: false, version: 3, generation: 'generation', exists: true, failSave: false, failedCheck: false };
  const repository = { async readGenerated() { calls.push('admin'); if (state.denied) throw Object.assign(new Error('private-denial'), { status: 404 }); return {}; },
    async installationSnapshot() { calls.push('snapshot'); if (state.denied) throw Object.assign(new Error('private-denial'), { status: 404 });
      return { connectionVersion: state.version, credentialVersion: 2, connectionGeneration: state.generation }; },
    async put(input) { calls.push(['put', input]); if (state.failSave) throw Object.assign(new Error('private-concurrent-change'), { status: 409 }); return {}; } };
  const imports = {
    './connectors/sentry-installation': { sentryInstallationClient: () => undefined },
    './connectors/googlechat-native': { googleChatNativeApp: () => undefined },
    './connectors/oauth': oauth,
    './app-connectors': { getAppConnectorProvider: id => APP_CONNECTOR_PROVIDER_MANIFESTS.find(m => m.id === id) },
    './app-connection-check': { checkAppConnection: async () => { calls.push('check'); return { ok: !state.failedCheck }; } },
    './deployment-origins': { appOrigin: () => 'https://xmatrix.test' },
    './connectors/vercel-api': { vercelCompletionUrl: () => undefined },
    './connectors/credentials': { connectorCredentialRepository: () => repository, mintConnectorSecret: () => 'unneeded', INGRESS_KEY_FIELD: 'ingressKey' },
    '@xmatrix/protocol': { HUB_ROUTES },
    './index-shared': { requireAuth: async () => ({ agentRun: state.agent }), requireHumanAuth: () => ({ id: state.signedIn ?? 'human-admin' }),
      connectorHubOrigin: () => 'https://hub.test',
      jsonErrors: async (context, run) => { try { return await run(); } catch (error) { return context.json({ error: error.message }, error.status ?? 500); } } },
    '@xmatrix/db': { ControlError },
    './apps': {
      getAppConnection: async () => { calls.push('query'); if (state.exists) return { connection: {} };
        throw new ControlError('app_connection_not_found', 404, 'App connection not found'); },
      upsertAppConnection: async () => { calls.push('create'); state.exists = true; return {}; },
    },
  };
  const app = new Hono(); route(name => imports[name]).registerConnectorOAuthRoutes(app);
  return { state, calls, start: () => app.request('/api/spaces/chosen-space/app-connections/discord/oauth/start', { method: 'POST' }, env),
    callback: async oauthState => {
      // The provider's redirect only hands the grant to the signed-in app, which completes it.
      const redirected = await app.request(`/api/connectors/oauth/callback?state=${encodeURIComponent(oauthState)}&code=single-code&guild_id=923456789012345678&permissions=8`, {}, env);
      assert.equal(redirected.status, 302);
      const handoff = new URL(redirected.headers.get('location'));
      assert.equal(handoff.origin + handoff.pathname, 'https://xmatrix.test/connect/oauth');
      const completed = await app.request(HUB_ROUTES.connector_oauth_complete, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(handoff.searchParams)) }, env);
      if (completed.status !== 200) return completed;
      return new Response(null, { status: 302, headers: { location: (await completed.json()).redirect } });
    } };
}
async function begin(f) { const response = await f.start(); assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store'); return new URL((await response.json()).url).searchParams.get('state'); }
function provider() { return stubFetchResponses([{ body: { access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 604800,
  scope: 'bot identify', token_type: 'Bearer', guild: { id: guildId } } }, { body: { application: { id: appId }, user: { id: userId },
  scopes: ['bot', 'identify'], expires: new Date(Date.now() + 3600000).toISOString() } }]); }

test('Discord start is Human+live Space-admin only and creates a missing row before signing its snapshot; existing grants are untouched', async () => {
  const agent = fixture(); agent.state.agent = true; assert.equal((await agent.start()).status, 403); assert.deepEqual(agent.calls, []);
  const denied = fixture(); denied.state.denied = true; assert.equal((await denied.start()).status, 404); assert.deepEqual(denied.calls, ['admin']);
  const existing = fixture(); await begin(existing); assert.deepEqual(existing.calls, ['admin', 'query', 'snapshot']);
  const fresh = fixture(); fresh.state.exists = false; await begin(fresh); assert.deepEqual(fresh.calls, ['admin', 'query', 'create', 'snapshot']);
});

test('callback ignores forged guild/permissions hints and atomically installs against the original Space snapshot, then requires real Check', async () => {
  const f = fixture(), state = await begin(f), p = provider();
  try { const response = await f.callback(state); assert.equal(response.status, 302);
    assert.match(response.headers.get('location'), /oauth=connected/); const saved = f.calls.find(c => Array.isArray(c) && c[0] === 'put')[1];
    assert.equal(saved.spaceId, 'chosen-space'); assert.equal(saved.actorUserId, 'human-admin'); assert.equal(saved.fields.oauthGuildId, guildId);
    assert.deepEqual(saved.expectedInstallationSnapshot, { connectionVersion: 3, credentialVersion: 2, connectionGeneration: 'generation' });
    assert.equal(f.calls.filter(c => c === 'create').length, 0); assert.equal(f.calls.at(-1), 'check');
  } finally { p.restore(); }
});

test('revoked admin, disconnect/reconnect or recreated generation rejects before exchange; a commit conflict prevents Check and success', async () => {
  for (const change of ['denied', 'version', 'generation']) {
    const f = fixture(), state = await begin(f), p = stubFetchResponses([]);
    if (change === 'denied') f.state.denied = true; if (change === 'version') f.state.version++;
    if (change === 'generation') f.state.generation = 'recreated';
    try { assert.match((await f.callback(state)).headers.get('location'), /oauth=failed/); assert.equal(f.calls.includes('check'), false); }
    finally { p.restore(); }
  }
  for (const option of ['failSave', 'failedCheck']) { const f = fixture(), state = await begin(f), p = provider(); f.state[option] = true;
    try { assert.match((await f.callback(state)).headers.get('location'), /oauth=failed/); if (option === 'failSave') assert.equal(f.calls.includes('check'), false); }
    finally { p.restore(); }
  }
});

test('a connect link completed by anyone but the admin who started it is refused before the code is exchanged', async () => {
  const f = fixture(), state = await begin(f), p = stubFetchResponses([]);
  f.state.signedIn = 'someone-else';
  try {
    const response = await f.callback(state);
    assert.equal(response.status, 403);
    assert.equal(f.calls.some(c => Array.isArray(c) && c[0] === 'put'), false);
    assert.equal(f.calls.includes('check'), false);
  } finally { p.restore(); }
});
