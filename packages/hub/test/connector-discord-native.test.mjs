import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discordActionCapability, verifyDiscordNativeConnection } from '../src/connectors/discord-native.ts';
import { DISCORD_ACTIONS, verifyDiscord } from '../src/connectors/actions/discord.ts';
import { stubFetchResponses } from './support/fetch-responses.mjs';

const appId = '123456789012345678', guildId = '223456789012345678', userId = '323456789012345678', channelId = '423456789012345678';
function fixture() {
  const calls = []; const state = { allowed: true, changed: false, changeAt: '', refreshed: false, manual: false, missing: false, invalid: false, status: 'configured', crossGuild: false, channelType: 0, failWrite: false };
  const values = { oauthToken: 'private-access', oauthRefreshToken: 'private-refresh', oauthExpiresAt: String(Date.now() + 3600000),
    oauthClientId: appId, oauthGuildId: guildId, oauthUserId: userId, oauthScopes: 'bot identify' };
  const dependencies = {
    app: () => ({ clientId: appId, clientSecret: 'private-client', botToken: 'private-bot' }),
    credentials: () => ({ async resolve(input) { calls.push('resolve');
      return state.missing ? null : { connectionId: 'space:discord', spaceId: input.spaceId, providerId: 'discord', status: state.status,
        version: state.refreshed ? 3 : 2, connectionVersion: state.changed ? 5 : 4, connectionGeneration: 'generation',
        values: state.manual ? { botToken: 'own-bot' } : { ...values, ...(state.invalid ? { oauthClientId: 'bad' } : {}) } }; } }),
    async refresh() { calls.push('refresh'); state.refreshed = true; if (state.changeAt === 'refresh') state.changed = true; },
    async authorization() { calls.push('authorization'); if (state.changeAt === 'authorization') state.changed = true; },
    async verifyBot() { calls.push('membership'); if (state.changeAt === 'membership') state.changed = true; },
    async json(path, token, body) { calls.push(body ? 'post' : 'channel');
      if (!body) { if (state.changeAt === 'channel') state.changed = true; if (state.changeAt === 'policy') state.allowed = false;
        return { id: channelId, guild_id: state.crossGuild ? '523456789012345678' : guildId, type: state.channelType }; }
      if (state.failWrite) throw new Error('provider timeout');
      assert.equal(path, `/channels/${channelId}/messages`); assert.equal(token, 'Bot private-bot');
      assert.deepEqual(body.allowed_mentions, { parse: [], replied_user: false }); return { id: '623456789012345678', channel_id: channelId };
    },
  };
  const authorize = async () => { calls.push('policy'); if (!state.allowed) throw new Error('policy denied'); };
  return { calls, state, capability: () => discordActionCapability({}, 'space', authorize, dependencies),
    check: () => verifyDiscordNativeConnection({}, 'space', dependencies) };
}

test('native post capability hides secrets, checks provider grant and guild, and rereads current snapshot+policy immediately before one write', async () => {
  const f = fixture(); const capability = await f.capability(); assert.deepEqual(Object.keys(capability), ['postMessage']);
  await capability.postMessage(channelId, 'test @everyone');
  assert.deepEqual(f.calls, ['resolve', 'refresh', 'resolve', 'resolve', 'policy', 'authorization', 'membership', 'channel', 'resolve', 'policy', 'post']);
  assert.equal(f.calls.filter(x => x === 'post').length, 1);
});

test('policy changes, cross-guild channels, disconnects and reconnect/ABA during refresh or provider reads cannot post', async () => {
  for (const changeAt of ['refresh', 'authorization', 'membership', 'channel', 'policy']) {
    const f = fixture(); f.state.changeAt = changeAt;
    await assert.rejects(async () => (await f.capability()).postMessage(channelId, 'no write'));
    assert.equal(f.calls.includes('post'), false);
  }
  for (const option of ['policy', 'guild', 'disconnect', 'invalid', 'dm', 'thread']) {
    const f = fixture(); if (option === 'policy') f.state.allowed = false;
    if (option === 'guild') f.state.crossGuild = true; if (option === 'disconnect') f.state.status = 'disconnected';
    if (option === 'invalid') f.state.invalid = true;
    if (option === 'dm') f.state.channelType = 1; if (option === 'thread') f.state.channelType = 11;
    await assert.rejects(async () => (await f.capability()).postMessage(channelId, 'no write'));
    assert.equal(f.calls.includes('post'), false);
  }
});

test('native Check verifies authorization+membership and rejects a snapshot changed in flight; manual mode is explicit', async () => {
  const f = fixture(); assert.equal(await f.check(), true); assert.equal(f.calls.includes('post'), false);
  const changed = fixture(); changed.state.changeAt = 'membership'; await assert.rejects(changed.check(), /changed during Check/);
  for (const option of ['manual', 'missing']) { const manual = fixture(); manual.state[option] = true;
    assert.equal(await manual.capability(), undefined); assert.equal(await manual.check(), false);
    assert.ok(manual.calls.every(x => x === 'resolve')); }
});

test('legacy own-bot post still suppresses mentions; an OAuth token without native capability never masquerades as a bot', async () => {
  await assert.rejects(DISCORD_ACTIONS.post.execute({ credentials: { oauthToken: 'user-token' } }, { channel: channelId, text: 'no' }), /Reconnect/);
  const provider = stubFetchResponses([{ body: { id: '623456789012345678' } }, { body: { id: appId, bot: true } }]);
  try { await DISCORD_ACTIONS.post.execute({ credentials: { botToken: 'own-bot' } }, { channel: channelId, text: 'one' });
    await verifyDiscord({ botToken: 'own-bot' }); assert.equal(provider.calls[0].headers.get('authorization'), 'Bot own-bot');
  } finally { provider.restore(); }
});


test('an ambiguous provider failure never retries the native message write', async () => {
  const f = fixture(); f.state.failWrite = true;
  await assert.rejects((await f.capability()).postMessage(channelId, "single attempt"), /timeout/);
  assert.equal(f.calls.filter(call => call === "post").length, 1);
});
