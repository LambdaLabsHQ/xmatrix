import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hmacHex } from '@xmatrix/protocol';
import { handleVercelAppDelivery } from '../src/connectors/vercel-app-ingress.ts';
import { exchangeOAuthGrant, oauthClient } from '../src/connectors/oauth.ts';

const env = { CONNECTOR_VERCEL_CLIENT_ID: 'oac_app', CONNECTOR_VERCEL_CLIENT_SECRET: 'fixture-integration-secret' };
const event = (extra = {}) => ({ id: 'evt_1', type: 'deployment.ready', payload: {
  team: { id: 'team_A' }, user: { id: 'ownerA' }, project: { id: 'prj_A' },
  deployment: { id: 'dpl_A', name: 'test-app', url: 'test-app.vercel.app' }, ...extra,
} });
const connection = (space = 'a', id = 'icfg_A') => ({ connectionId: `${space}:vercel`, spaceId: space,
  installationId: id, credentialVersion: 3 });
function fixture(connections = [connection()]) {
  const appends = [], automations = [], queries = [], routeQueries = [], resolved = [], retirements = [];
  const apps = {
    async vercelEventConnections(input) { queries.push(input); return connections; },
    async connectorEventRoutes(input) { routeQueries.push(input);
      return [{ channelId: `${input.connectionId}:test`, authorityRootUserId: 'owner', features: ['succeeded', 'failed', 'created'] }]; },
    async retireVercelInstallation(input) { retirements.push(input); return 1; },
  };
  const dependencies = {
    apps: () => apps,
    credentials: () => ({ async resolve(input) { resolved.push(input); const c = connections.find(c => c.spaceId === input.spaceId);
      return c && { connectionId: c.connectionId, status: 'configured', version: c.credentialVersion,
        values: { oauthToken: `fixture-${c.installationId}`, oauthAppClientId: 'oac_app',
          oauthConfigurationId: c.installationId, oauthTeamId: 'team_A' } }; } }),
    async append(_env, _channel, input) { appends.push(input); return Response.json({}); },
    async automations(_env, input) { automations.push(input); },
  };
  return { appends, automations, queries, routeQueries, resolved, retirements, apps, dependencies };
}
async function send(payload, f, secret = env.CONNECTOR_VERCEL_CLIENT_SECRET, requestEnv = env) {
  const raw = JSON.stringify(payload);
  return handleVercelAppDelivery({ env: requestEnv, request: new Request('https://hub.test/api/connectors/vercel/events', {
    method: 'POST', body: raw, headers: { 'x-vercel-signature': await hmacHex('SHA-1', secret, raw) },
  }) }, f.dependencies);
}
async function provider(body, run) {
  const before = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), token: new Headers(init.headers).get('authorization') });
    return body(String(url), init);
  };
  try { await run(calls); } finally { globalThis.fetch = before; }
}
const configuration = (id = 'icfg_A', extra = {}) => ({ id, integrationId: 'oac_app', teamId: 'team_A',
  projectSelection: 'selected', projects: ['prj_A'], ...extra });

test('integration signature is verified before any Space lookup; unknown events have no side effects', async () => {
  const f = fixture();
  assert.equal((await send(event(), f, 'forged')).status, 401);
  assert.equal((await send(event(), f, undefined, { ...env, CONNECTOR_VERCEL_CLIENT_SECRET: '' })).status, 404);
  assert.equal((await send({ ...event(), type: 'domain.created' }, f)).status, 200);
  assert.equal(f.queries.length + f.resolved.length + f.retirements.length, 0);
  assert.equal((await send({ ...event(), padding: 'a'.repeat(256 * 1024) }, f)).status, 413);
});

test('current project permissions isolate two installations in the same team and dedupe redelivery', async () => {
  const f = fixture([connection('a'), connection('b', 'icfg_B')]);
  await provider(url => Response.json(configuration(url.includes('icfg_B') ? 'icfg_B' : 'icfg_A',
    { projects: url.includes('icfg_B') ? ['prj_B'] : ['prj_A'] })), async calls => {
    assert.deepEqual(await (await send(event(), f)).json(), { ok: true, events: 1, delivered: 1 });
    assert.equal(f.appends.length, 1);
    assert.match(f.appends[0].channelId, /^a:/);
    assert.deepEqual(f.automations.map(item => item.spaceId), ['a']);
    assert.ok(calls.every(call => call.url.startsWith('https://api.vercel.com/v1/integrations/configuration/icfg_') &&
      new URL(call.url).searchParams.get('teamId') === 'team_A'));
    assert.ok(f.routeQueries.every(q => q.oauthBinding.installationId === 'icfg_A' && q.oauthBinding.credentialVersion === 3));
    await send(event(), f);
    assert.equal(f.appends[0].commandId, f.appends[1].commandId);
  });
});

test('a changed credential snapshot cannot authorize a stale event or Automation', async () => {
  const f = fixture();
  f.dependencies.credentials = () => ({ async resolve() { return { connectionId: 'a:vercel', status: 'configured', version: 4,
    values: { oauthToken: 't', oauthConfigurationId: 'icfg_A', oauthAppClientId: 'oac_app', oauthTeamId: 'team_A' } }; } });
  await provider(() => { throw new Error('stale credentials must not reach Vercel'); }, async calls => {
    assert.equal((await send(event(), f)).status, 200);
    assert.equal(calls.length + f.appends.length + f.automations.length, 0);
  });
  const reconnected = fixture();
  let reads = 0;
  reconnected.apps.vercelEventConnections = async () => [connection('a')].map(c => ({ ...c, credentialVersion: ++reads === 1 ? 3 : 4 }));
  reconnected.apps.connectorEventRoutes = async () => [];
  await provider(() => Response.json(configuration()), async () => {
    await send(event(), reconnected);
    assert.equal(reconnected.appends.length + reconnected.automations.length, 0);
  });
});

test('missing scope/project/id, transferred configuration and malformed permissions fail closed', async () => {
  for (const payload of [event({ team: undefined }), event({ project: {} }), { ...event(), id: undefined }]) {
    const f = fixture();
    assert.equal((await send(payload, f)).status, 400);
    assert.equal(f.queries.length + f.appends.length, 0);
  }
  for (const body of [configuration('icfg_other'), configuration('icfg_A', { teamId: 'team_B' }),
    configuration('icfg_A', { disabledAt: 1 }), configuration('icfg_A', { integrationId: 'oac_other' })]) {
    const f = fixture();
    await provider(() => Response.json(body), async () => {
      await send(event(), f);
      assert.equal(f.appends.length + f.automations.length, 0);
    });
  }
  await provider(() => Response.json(configuration('icfg_A', { projectSelection: 'unknown' })), async () => {
    await assert.rejects(send(event(), fixture()), /project permissions/);
  });
});

test('provider outages and failed append require retry; they are not successful drops', async () => {
  await provider(() => Response.json({ error: 'temporarily unavailable' }, { status: 503 }), async () => {
    await assert.rejects(send(event(), fixture()));
  });
  const f = fixture();
  f.dependencies.append = async () => Response.json({}, { status: 503 });
  await provider(() => Response.json(configuration()), async () => {
    await assert.rejects(send(event(), f), /Channel delivery failed/);
    assert.equal(f.automations.length, 0);
  });
});

test('personal account events use the authenticated user scope and never a stale manual team', async () => {
  const f = fixture();
  f.dependencies.credentials = () => ({ async resolve() { return { connectionId: 'a:vercel', status: 'configured', version: 3,
    values: { oauthToken: 't', oauthConfigurationId: 'icfg_A', oauthAppClientId: 'oac_app', oauthUserId: 'ownerA', teamId: 'team_other' } }; } });
  await provider(() => Response.json(configuration('icfg_A', { teamId: null, userId: 'ownerA', projectSelection: 'all' })), async calls => {
    assert.equal((await send(event({ team: null }), f)).status, 200);
    assert.equal(f.queries[0].eventScopeId, 'user_ownerA');
    assert.equal(f.appends.length, 1);
    assert.equal(new URL(calls[0].url).searchParams.has('teamId'), false);
  });
});

test('signed removal and transfer retire only the installation and previous scope named by Vercel', async () => {
  const f = fixture();
  const removal = { ...event({ configuration: { id: 'icfg_A' } }), type: 'integration-configuration.removed' };
  assert.equal((await send(removal, f)).status, 200);
  assert.equal(f.retirements[0].installationId, 'icfg_A');
  assert.equal(f.retirements[0].eventScopeId, 'team_A');
  assert.equal(f.retirements[0].appClientId, 'oac_app');
  assert.equal(f.resolved.length + f.appends.length, 0);
  assert.equal((await send(removal, f, 'forged')).status, 401);
  const transfer = { ...removal, type: 'integration-configuration.transferred',
    payload: { configuration: { id: 'icfg_A' }, previousTeamId: 'team_A', newTeamId: 'team_B' } };
  assert.equal((await send(transfer, f)).status, 200);
  assert.equal(f.retirements.at(-1).eventScopeId, 'team_A');
});

test('OAuth creates configuration/account bindings from verified provider evidence for team and personal grants', async () => {
  for (const team of ['team_A', null]) {
    await provider(url => Response.json(url.endsWith('/v2/oauth/access_token')
      ? { access_token: 't', installation_id: 'icfg_A', team_id: team, user_id: 'ownerA' }
      : configuration('icfg_A', { teamId: team, userId: 'ownerA' })), async () => {
      const grant = await exchangeOAuthGrant(oauthClient(env, 'vercel'), 'code', 'https://hub.test/callback');
      assert.deepEqual(grant.installation, { appClientId: 'oac_app', installationId: 'icfg_A',
        eventScopeId: team ?? 'user_ownerA' });
      assert.equal(grant.fields.oauthUserId, team ? null : 'ownerA');
    });
  }
});
