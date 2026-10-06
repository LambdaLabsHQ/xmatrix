import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { handleDiscordLifecycleDelivery } from '../src/connectors/discord-events.ts';

const appId = '123456789012345678', userId = '323456789012345678', guildId = '223456789012345678';
const now = Date.parse('2026-10-04T21:00:00Z');
const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const env = { CONNECTOR_DISCORD_PUBLIC_KEY: publicKey };
const envelope = (type = 'APPLICATION_DEAUTHORIZED', data = { user: { id: userId, username: 'private-profile' } }) =>
  ({ version: 1, application_id: appId, type: 1, event: { type, timestamp: '2026-10-04T20:59:00.123456', data } });
function fixture() {
  const calls = [];
  const dependencies = { app: () => ({ clientId: appId }), lifecycle: () => ({ async receive(value) { calls.push(value); } }) };
  const request = (payload, options = {}) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const timestamp = options.timestamp ?? String(now / 1000);
    const signature = sign(null, Buffer.from(timestamp + body), options.privateKey ?? pair.privateKey).toString('hex');
    return new Request('https://hub.test/api/connectors/discord/events?spaceId=attacker', { method: 'POST',
      headers: { 'x-signature-ed25519': options.signature ?? signature, 'x-signature-timestamp': timestamp },
      body: options.body ?? body });
  };
  return { calls, request, receive: (req, config = env) => handleDiscordLifecycleDelivery(config, req, dependencies, now) };
}

test('real Ed25519 PING has native empty 204 and no database or interaction response', async () => {
  const f = fixture(); const result = await f.receive(f.request({ version: 1, application_id: appId, type: 0 }));
  assert.equal(result.status, 204); assert.equal(await result.text(), ''); assert.equal(result.headers.get('content-type'), 'application/json');
  assert.equal(result.body, null);
  assert.deepEqual(f.calls, []);
});

test('real signature validates exact raw bytes and strict fresh timestamp before parsing or authority lookup', async () => {
  const f = fixture(); const payload = envelope();
  for (const options of [{ body: JSON.stringify(payload) + ' ' }, { signature: '00'.repeat(64) },
    { privateKey: generateKeyPairSync('ed25519').privateKey }, { timestamp: String(now / 1000 - 301) },
    { timestamp: String(now / 1000 + 301) }, { timestamp: '1.759e9' }, { timestamp: '01759699200' }, { signature: 'bad' }]) {
    assert.equal((await f.receive(f.request(payload, options))).status, 401);
  }
  assert.deepEqual(f.calls, []);
  assert.equal((await f.receive(f.request(payload), {})).status, 404);
  assert.equal((await f.receive(f.request(payload), { CONNECTOR_DISCORD_PUBLIC_KEY: 'bad' })).status, 404);
});

test('signed lifecycle strips user profiles and untrusted Space/guild revocation hints; every success is empty 204', async () => {
  const f = fixture(); const payload = envelope(); payload.event.data.guild = { id: '423456789012345678' };
  payload.event.data.spaceId = 'attacker';
  const response = await f.receive(f.request(payload)); assert.equal(response.status, 204); assert.equal(await response.text(), '');
  assert.deepEqual(Object.keys(f.calls[0]).sort(), ['appClientId','eventAt','requestId','type','userId']);
  assert.equal(f.calls[0].eventAt, '2026-10-04T20:59:00.123Z'); assert.equal(f.calls[0].userId, userId);
  assert.doesNotMatch(JSON.stringify(f.calls), /private-profile|attacker|423456/);
  const auth = await f.receive(f.request(envelope('APPLICATION_AUTHORIZED', { integration_type: 0,
    user: { id: userId }, guild: { id: guildId }, scopes: ['bot', 'identify'] })));
  assert.equal(auth.status, 204); assert.equal(f.calls[1].guildId, guildId);
  // The official integration_type field is optional; authenticated guild data
  // still observes only a current exact binding, never a user installation.
  assert.equal((await f.receive(f.request(envelope('APPLICATION_AUTHORIZED', { user: { id: userId },
    guild: { id: guildId }, scopes: ['bot', 'identify'] })))).status, 204);
  assert.equal(f.calls[2].guildId, guildId);
});

test('signed invalid application, version, JSON, lifecycle user, guild, scopes and event time cannot mutate grants', async () => {
  const invalid = [null, { ...envelope(), application_id: '423456789012345678' }, { ...envelope(), version: 2 },
    { ...envelope(), type: '1' }, '{invalid', { ...envelope(), event: {} }];
  for (const data of [{}, { user: { id: 'bad' } }, { user: { id: userId, bot: true } }]) invalid.push(envelope('APPLICATION_DEAUTHORIZED', data));
  for (const extra of [{ integration_type: 2 }, { guild: { id: 'bad' } }, { scopes: ['bot', 'identify', 'email'] }]) {
    invalid.push(envelope('APPLICATION_AUTHORIZED', { integration_type: 0, user: { id: userId }, guild: { id: guildId }, scopes: ['bot', 'identify'], ...extra }));
  }
  for (const timestamp of ['bad', '2026-02-30T20:59:00Z', '2026-10-04T21:01:00Z', '2026-10-04T20:44:59Z']) {
    invalid.push({ ...envelope(), event: { ...envelope().event, timestamp } });
  }
  const f = fixture(); for (const payload of invalid) assert.equal((await f.receive(f.request(payload))).status, 400);
  assert.deepEqual(f.calls, []);
});

test('ordinary Gateway and Social SDK messages, entitlements and user installs never become guild inbound events or Space grants', async () => {
  const f = fixture();
  for (const type of ['MESSAGE_CREATE', 'LOBBY_MESSAGE_CREATE', 'GAME_DIRECT_MESSAGE_CREATE', 'ENTITLEMENT_CREATE']) {
    assert.equal((await f.receive(f.request(envelope(type)))).status, 204);
  }
  assert.equal((await f.receive(f.request(envelope('APPLICATION_AUTHORIZED', { integration_type: 1, user: { id: userId } })))).status, 204);
  assert.deepEqual(f.calls, []);
});

test('oversized signed request fails before lifecycle dispatch and a database failure never acknowledges acceptance', async () => {
  const f = fixture(); assert.equal((await f.receive(f.request('x'.repeat(256 * 1024 + 1)))).status, 413);
  assert.deepEqual(f.calls, []);
  await assert.rejects(handleDiscordLifecycleDelivery(env, f.request(envelope()), {
    app: () => ({ clientId: appId }), lifecycle: () => ({ async receive() { throw new Error('authority unavailable'); } }),
  }, now), /authority unavailable/);
});

test('the actual shared Hono dispatch reaches signed Discord PING before generic ingress; anonymous probes and failures are sanitized', async () => {
  const { Hono } = await import('hono');
  const { HUB_ROUTES } = await import('@xmatrix/protocol');
  const { compileCommonJsSourceModule } = await import('./support/commonjs-source-module.mjs');
  const route = await compileCommonJsSourceModule(new URL('../src/index-routes-connectors.ts', import.meta.url));
  const noop = () => {};
  const f = fixture(); let fail = false, generic = 0;
  const imports = {
    '@xmatrix/protocol': { HUB_ROUTES },
    './connectors/discord-events': { handleDiscordLifecycleDelivery: (env, request) => {
      if (fail) throw new Error('private-token/private-payload');
      return handleDiscordLifecycleDelivery(env, request, { app: () => ({ clientId: appId }),
        lifecycle: () => ({ async receive() { throw new Error('PING must not query PG'); } }) }, now);
    } },
    './connectors/event-ingress': { async handleAppConnectorDelivery() { generic++; return new Response(null, { status: 404 }); } },
    './connectors/registry': { connectorProvider: () => undefined },
    './index-routes-googlechat': { registerGoogleChatRoutes: noop },
    './index-routes-teams': { registerTeamsRoutes: noop },
    './index-routes-feishu': { registerFeishuRoutes: noop },
    './index-routes-telegram': { registerTelegramRoutes: noop },
    './index-routes-wecom': { registerWeComRoutes: noop },
    './index-routes-dingtalk': { registerDingTalkRoutes: noop },
  };
  const app = new Hono(); route(name => imports[name] ?? {}).registerConnectorRoutes(app);
  const ping = { version: 1, application_id: appId, type: 0 };
  const acknowledged = await app.fetch(f.request(ping), env);
  assert.equal(acknowledged.status, 204);
  assert.equal(acknowledged.headers.get('content-type'), 'application/json');
  assert.equal(acknowledged.body, null);
  assert.equal(await acknowledged.text(), '');
  assert.deepEqual(f.calls, []);
  assert.equal((await app.fetch(new Request('https://hub.test/api/connectors/discord/events', { method: 'POST', body: '{}' }), env)).status, 401);
  assert.equal(generic, 0);
  fail = true; const failed = await app.fetch(f.request(ping), env);
  assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /private-token|private-payload/);
});
