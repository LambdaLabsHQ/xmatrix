import assert from 'node:assert/strict';
import test from 'node:test';
import { hmacHex } from '@xmatrix/protocol';
import { connectorProvider } from '../src/connectors/registry.ts';
import { handleAppConnectorDelivery } from '../src/connectors/event-ingress.ts';
import { exchangeOAuthGrant, oauthClient } from '../src/connectors/oauth.ts';

const env = {
  CONNECTOR_SLACK_CLIENT_ID: 'slack-app', CONNECTOR_SLACK_CLIENT_SECRET: 'slack-client-secret',
  CONNECTOR_SLACK_SIGNING_SECRET: 'slack-signing',
  CONNECTOR_LINEAR_CLIENT_ID: 'linear-app', CONNECTOR_LINEAR_CLIENT_SECRET: 'linear-client-secret',
  CONNECTOR_LINEAR_SIGNING_SECRET: 'linear-signing',
};
async function request(provider, payload, secret = env[`CONNECTOR_${provider.toUpperCase()}_SIGNING_SECRET`]) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now()/1000));
  const headers = provider === 'slack' ? { 'x-slack-request-timestamp': timestamp,
    'x-slack-signature': `v0=${await hmacHex('SHA-256', secret, `v0:${timestamp}:${body}`)}` }
    : { 'linear-signature': await hmacHex('SHA-256', secret, body), 'linear-delivery': 'delivery-1' };
  return new Request(`https://hub.test/api/connectors/${provider}/events?spaceId=attacker`,
    { method: 'POST', headers, body });
}
function fixture(bindings = [{ connectionId: 'space-a:slack', spaceId: 'space-a' }]) {
  const queries = [], routes = [], appends = [], automations = [];
  const apps = {
    async oauthEventConnections(query) { queries.push(query); return bindings; },
    async connectorEventRoutes(query) {
      routes.push(query);
      return [{ channelId: `${query.connectionId}:channel`, authorityRootUserId: 'owner', features: ['messages', 'issue'] }];
    },
  };
  return { queries, routes, appends, automations, apps, dependencies: {
    credentials() { throw new Error('App delivery must not decrypt arbitrary Space tokens'); },
    apps: () => apps,
    async append(_env, _channel, command) { appends.push(command); return new Response('{}'); },
    async automations(_env, trigger) { automations.push(trigger); },
  } };
}
const message = (team = 'T1') => ({ type: 'event_callback', team_id: team, event_id: 'Ev1',
  event: { type: 'message', channel: 'C1', user: 'U1', text: 'hello', ts: '1.2' } });
const send = async (provider, payload, f, options = {}) => handleAppConnectorDelivery({
  env: options.env ?? env, provider: connectorProvider(provider),
  request: await request(provider, payload, options.secret),
}, f.dependencies);

test('Slack challenge is signed and needs no Space connection', async () => {
  const f = fixture();
  const result = await send('slack', { type: 'url_verification', challenge: 'challenge-1' }, f);
  assert.deepEqual(await result.json(), { challenge: 'challenge-1' });
  assert.equal(f.queries.length, 0);
  assert.equal((await send('slack', { type: 'url_verification', challenge: 'bad' }, f, { secret: 'wrong' })).status, 401);
});

test('Slack routes only its signed workspace through current OAuth application bindings', async () => {
  const f = fixture([{ connectionId: 'space-a:slack', spaceId: 'space-a' }, { connectionId: 'space-b:slack', spaceId: 'space-b' }]);
  const first = await send('slack', message(), f);
  assert.deepEqual(await first.json(), { ok: true, events: 1, delivered: 2 });
  assert.equal(f.appends.length, 2, 'source and wildcard subscriptions deduplicate');
  assert.deepEqual(f.automations.map(t => t.spaceId), ['space-a', 'space-b']);
  assert.ok(f.queries.every(q => q.providerId === 'slack' && q.appClientId === 'slack-app' && q.installationId === 'T1'));
  assert.ok(f.routes.every(q => q.oauthBinding.installationId === 'T1'));
  assert.ok(f.appends.every(a => !a.channelId.includes('attacker')));
  await send('slack', message(), f);
  assert.equal(f.appends[0].commandId, f.appends[2].commandId, 'redelivery uses the existing append dedupe key');
});

test('unknown installations acknowledge without cross-Space delivery; forgeries never query authority', async () => {
  const f = fixture([]);
  assert.equal((await send('slack', message('unknown'), f)).status, 200);
  assert.equal(f.appends.length, 0);
  f.queries.length = 0;
  assert.equal((await send('slack', message(), f, { secret: 'wrong' })).status, 401);
  assert.equal(f.queries.length, 0);
  assert.equal((await send('slack', message(), f, { env: { ...env, CONNECTOR_SLACK_SIGNING_SECRET: '' } })).status, 404);
  assert.equal((await send('slack', message(''), f)).status, 400);
});

test('Linear app events require a signed organization id and fresh timestamp', async () => {
  const f = fixture([{ connectionId: 'space-a:linear', spaceId: 'space-a' }]);
  const payload = { type: 'Issue', action: 'create', organizationId: 'org-a', webhookTimestamp: Date.now(),
    data: { id: 'issue-a', identifier: 'ENG-1', title: 'Test', team: { key: 'ENG' } } };
  assert.equal((await send('linear', payload, f)).status, 200);
  assert.equal(f.appends.length, 1);
  assert.equal(f.queries[0].installationId, 'org-a');
  assert.equal((await send('linear', { ...payload, organizationId: undefined }, f)).status, 400);
  for (const timestamp of [undefined, 'invalid', Date.now()-120000]) {
    assert.equal((await send('linear', { ...payload, webhookTimestamp: timestamp }, f)).status, 401);
  }
});

test('reauthorization between workspace lookup and route reads suppresses stale automation delivery', async () => {
  const f = fixture();
  let calls = 0;
  f.apps.oauthEventConnections = async () => ++calls === 1 ? [{ connectionId: 'space-a:slack', spaceId: 'space-a' }] : [];
  // The SQL route read independently rechecks the same grant after reauthorization.
  f.apps.connectorEventRoutes = async (q) => { assert.equal(q.oauthBinding.installationId, 'T1'); return []; };
  assert.equal((await send('slack', message(), f)).status, 200);
  assert.equal(f.appends.length, 0);
  assert.equal(f.automations.length, 0);
});

test('oversized app deliveries fail before authority access', async () => {
  const f = fixture();
  assert.equal((await send('slack', { ...message(), padding: 'x'.repeat(256*1024) }, f)).status, 413);
  assert.equal(f.queries.length, 0);
});

test('failed Channel appends fail the app callback so the provider retries safely', async () => {
  const f = fixture();
  f.dependencies.append = async () => new Response('{}', { status: 503 });
  await assert.rejects(send('slack', message(), f), /Channel delivery failed/);
  assert.equal(f.automations.length, 0);
});

async function grant(provider, responses) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(responses.shift());
  };
  try { return { result: await exchangeOAuthGrant(oauthClient(env, provider), 'code', 'https://hub.test/cb'), calls }; }
  finally { globalThis.fetch = original; }
}

test('OAuth bindings come from the Slack token response and Linear organization query', async () => {
  const slack = await grant('slack', [{ ok: true, access_token: 'bot-token', team: { id: 'T2', name: 'Untrusted label' } }]);
  assert.deepEqual(slack.result.installation, { appClientId: 'slack-app', installationId: 'T2' });
  assert.doesNotMatch(JSON.stringify(slack.result), /Untrusted label/);
  const linear = await grant('linear', [{ access_token: 'linear-token' }, { data: { organization: { id: 'org-2' } } }]);
  assert.deepEqual(linear.result.installation, { appClientId: 'linear-app', installationId: 'org-2' });
  assert.equal(new Headers(linear.calls[1].init.headers).get('authorization'), 'Bearer linear-token');
  assert.equal(JSON.parse(linear.calls[1].init.body).query, 'query { organization { id } }');
});

test('ambiguous or unsupported OAuth installs fail before a route is bound', async () => {
  for (const response of [{ access_token: 't' }, { access_token: 't', team: { id: 'T1' }, is_enterprise_install: true }]) {
    await assert.rejects(grant('slack', [response]), /workspace/);
  }
  await assert.rejects(grant('linear', [{ access_token: 't' }, { data: { organization: { id: 'o1' } }, errors: [{ message: 'denied' }] }]), /workspace/);
});
