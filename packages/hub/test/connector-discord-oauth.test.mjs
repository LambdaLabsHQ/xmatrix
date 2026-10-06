import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stubFetchResponses } from './support/fetch-responses.mjs';
import { exchangeOAuthGrant, oauthAuthorizeUrl, oauthClient, verifyOAuthState, refreshOAuthFields } from '../src/connectors/oauth.ts';
import { discordCompanyApp, discordGrantContext, validateDiscordGrant, verifyDiscordBot } from '../src/connectors/discord-oauth.ts';

const appId = '123456789012345678', guildId = '223456789012345678', userId = '323456789012345678';
const env = { CONNECTOR_DISCORD_CLIENT_ID: appId, CONNECTOR_DISCORD_CLIENT_SECRET: 'fixture-client', CONNECTOR_DISCORD_BOT_TOKEN: 'fixture-bot' };
const snapshot = { connectionVersion: 3, credentialVersion: 2, connectionGeneration: 'original-rank' };
const client = oauthClient(env, 'discord'), redirectUri = 'https://hub.test/api/connectors/oauth/callback';
const token = (extra = {}) => ({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer',
  expires_in: 604800, scope: 'bot identify', guild: { id: guildId, name: 'unpersisted-profile' }, ...extra });
const authorization = (extra = {}) => ({ application: { id: appId }, user: { id: userId, username: 'not-stored' },
  scopes: ['bot', 'identify'], expires: new Date(Date.now() + 3600000).toISOString(), ...extra });
const stub = responses => stubFetchResponses(responses, { decodeBody: body => body instanceof URLSearchParams ? Object.fromEntries(body) : undefined });
const start = extra => oauthAuthorizeUrl(client, { spaceId: 'selected-space', userId: 'human-admin', redirectUri, connectionSnapshot: snapshot, ...extra });

test('Discord Guild Install requests only bot+identify and basic message permissions; state binds client, callback and original connection', async () => {
  assert.equal(discordCompanyApp({}), undefined);
  assert.throws(() => oauthClient({ CONNECTOR_DISCORD_CLIENT_ID: appId, CONNECTOR_DISCORD_CLIENT_SECRET: 'fixture' }, 'discord'), /not configured/);
  const url = new URL(await start());
  assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(url.searchParams.get('scope'), 'bot identify'); assert.equal(url.searchParams.get('permissions'), '3072');
  assert.equal(url.searchParams.get('integration_type'), '0'); assert.equal(url.searchParams.has('guild_id'), false);
  const state = url.searchParams.get('state'); const verified = await verifyOAuthState(env, state);
  assert.equal(verified.spaceId, 'selected-space'); assert.equal(verified.userId, 'human-admin');
  assert.deepEqual(verified.connectionSnapshot, snapshot);
  assert.equal(await verifyOAuthState({ ...env, CONNECTOR_DISCORD_CLIENT_ID: '423456789012345678' }, state), undefined);
  assert.equal(await verifyOAuthState({ ...env, CONNECTOR_DISCORD_CLIENT_SECRET: 'rotation' }, state), undefined);
  assert.equal(await verifyOAuthState(env, new URL(await start({ now: Date.now() - 660000 })).searchParams.get('state')), undefined);
  const unexpected = stub([]);
  try { await assert.rejects(exchangeOAuthGrant(client, 'code', 'https://forged.test/callback', state), /OAuth proof/); }
  finally { unexpected.restore(); }
});

test('code exchange obtains guild from authenticated response, verifies app+Human and never stores company bot or provider profiles', async () => {
  const provider = stub([{ body: token() }, { body: authorization() }]);
  try {
    const state = new URL(await start()).searchParams.get('state');
    const grant = await exchangeOAuthGrant(client, 'single-code', redirectUri, state);
    assert.equal(provider.calls[0].headers.get('authorization'), `Basic ${btoa(`${appId}:fixture-client`)}`);
    assert.equal(provider.calls[0].body.grant_type, 'authorization_code');
    assert.equal(provider.calls[0].body.redirect_uri, redirectUri);
    assert.equal(provider.calls[1].url, 'https://discord.com/api/v10/oauth2/@me');
    assert.equal(grant.fields.oauthGuildId, guildId); assert.equal(grant.fields.oauthUserId, userId);
    assert.equal(grant.fields.oauthClientId, appId); assert.equal(grant.fields.botToken, null);
    assert.doesNotMatch(JSON.stringify(grant), /fixture-bot|unpersisted-profile|not-stored/);
  } finally { provider.restore(); }
});

test('partial tokens, unrelated permissions, malformed guild, wrong app, bot user, expiry and provider failures fail without diagnostics leaking', async () => {
  for (const extra of [{ refresh_token: '' }, { token_type: 'Bot' }, { expires_in: 604801 }, { scope: 'bot identify email' },
    { scope: 'bot identify identify' }, { scope: 'identify' }, { guild: {} }]) {
    if ('guild' in extra) await assert.rejects(discordGrantContext(appId, token(extra)), /server installation/);
    else assert.throws(() => validateDiscordGrant(token(extra)), /server installation/);
  }
  for (const extra of [{ application: { id: '423456789012345678' } }, { user: { id: userId, bot: true } },
    { scopes: ['bot', 'identify', 'guilds'] }, { expires: 'invalid' }, { expires: '2020-01-01T00:00:00Z' }]) {
    const provider = stub([{ body: authorization(extra) }]);
    try { await assert.rejects(discordGrantContext(appId, token()), /server installation/); } finally { provider.restore(); }
  }
  const provider = stub([{ status: 401, body: { message: 'fixture-bot secret must stay private' } }]);
  try { await assert.rejects(discordGrantContext(appId, token()), error => error.status === 401 && !error.message.includes('secret')); }
  finally { provider.restore(); }
});

test('refresh validates rotating grant and keeps original guild and installing Human; app changes and grant substitution fail closed', async () => {
  const values = { oauthToken: 'old-access', oauthRefreshToken: 'old-refresh', oauthExpiresAt: String(Date.now() + 1000),
    oauthClientId: appId, oauthGuildId: guildId, oauthUserId: userId, oauthScopes: 'bot identify' };
  const provider = stub([{ body: token({ guild: undefined }) }, { body: authorization() }]);
  try {
    const fields = await refreshOAuthFields(env, 'discord', values);
    assert.equal(fields.oauthRefreshToken, 'fixture-refresh'); assert.equal(fields.oauthGuildId, guildId);
    assert.equal(fields.oauthUserId, userId); assert.equal(provider.calls[0].body.refresh_token, 'old-refresh');
  } finally { provider.restore(); }
  for (const body of [token({ guild: { id: '423456789012345678' } }), token({ refresh_token: '' })]) {
    const next = stub([{ body }]);
    try { await assert.rejects(refreshOAuthFields(env, 'discord', values), /server installation/); } finally { next.restore(); }
  }
  await assert.rejects(refreshOAuthFields({}, 'discord', values), /unavailable/);
  await assert.rejects(refreshOAuthFields({ ...env, CONNECTOR_DISCORD_CLIENT_ID: '423456789012345678' }, 'discord', values), /server installation/);
  assert.equal(await refreshOAuthFields({}, 'discord', { botToken: 'own-bot' }), undefined);
});


test('company bot Check verifies exact application, required code grant and guild membership; native failures expose no body', async () => {
  for (const body of [{ id: appId, bot_public: true, bot_require_code_grant: false },
    { id: appId, bot_public: false, bot_require_code_grant: true },
    { id: '423456789012345678', bot_public: true, bot_require_code_grant: true }]) {
    const p = stub([{ body }]); try { await assert.rejects(verifyDiscordBot(discordCompanyApp(env), guildId), /company bot/); }
    finally { p.restore(); }
  }
  const correct = { id: appId, bot_public: true, bot_require_code_grant: true };
  const p = stub([{ body: correct }, { body: { id: guildId } }]);
  try { await verifyDiscordBot(discordCompanyApp(env), guildId);
    assert.equal(p.calls[0].url, 'https://discord.com/api/v10/oauth2/applications/@me');
    assert.equal(p.calls[1].url, `https://discord.com/api/v10/guilds/${guildId}`);
    assert.ok(p.calls.every(c => c.headers.get('authorization') === 'Bot fixture-bot'));
  } finally { p.restore(); }
  const missing = stub([{ body: correct }, { status: 403, body: { message: 'private-guild-details' } }]);
  try { await assert.rejects(verifyDiscordBot(discordCompanyApp(env), guildId), error => error.status === 403 && !error.message.includes('private')); }
  finally { missing.restore(); }
});
