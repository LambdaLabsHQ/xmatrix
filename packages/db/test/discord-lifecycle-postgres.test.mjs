import assert from 'node:assert/strict';
import { Client } from 'pg';
import { readFile } from 'node:fs/promises';
import { connectionString, integration, postgresConnections } from './postgres-database.fixture.mjs';
import { PostgresAppCredentialRepository, PostgresDiscordLifecycleRepository } from '../dist/index.js';

const appId = '123456789012345678', userId = '323456789012345678', guildId = '223456789012345678';
const started = '2026-10-04T20:00:00.000Z', revoked = '2026-10-04T20:01:00.000Z';
const fields = { oauthClientId: appId, oauthGuildId: guildId, oauthUserId: userId,
  oauthToken: 'private-access', oauthRefreshToken: 'private-refresh', oauthExpiresAt: '1791154800000',
  oauthScopes: 'bot identify', botToken: null };
const policy = { allowed: Object.keys(fields) };
async function fixture(run) {
  const client = new Client({ connectionString }); await client.connect();
  const schema = `discord_${crypto.randomUUID().replaceAll('-', '')}`;
  const rewrite = sql => sql.replaceAll('data.', `${schema}.`);
  const sql = async (text, values) => (await client.query(rewrite(text), values)).rows;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await sql(`CREATE TABLE data.space_members(space_id text,user_id text,role text)`);
    await sql(`CREATE TABLE data.space_deletions(space_id text)`);
    await sql(`CREATE TABLE data.app_connector_connections(connection_id text PRIMARY KEY,space_id text,
      provider_id text,status text,version bigint,search_rank_sequence text,created_by text,
      updated_at timestamptz,last_checked_at timestamptz,error text)`);
    await sql(`CREATE TABLE data.app_connector_credentials(connection_id text PRIMARY KEY,space_id text,
      field_names_json jsonb,encrypted_value_json jsonb,version bigint,updated_by text,created_at timestamptz,updated_at timestamptz)`);
    for (const migration of ['0140_expand_connector_oauth_installations.sql', '0141_expand_vercel_event_scope.sql',
      '0142_expand_sentry_installation_binding.sql', '0144_expand_sentry_event_receipts.sql', '0153_expand_discord_installation_lifecycle.sql']) {
      // Execute the actual expand migration against the prior schema; unrelated
      // event-job tables need only their real source columns and foreign keys.
      await client.query('BEGIN');
      await sql(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
      await client.query('COMMIT');
    }
    const database = postgresConnections(5000, { rewrite });
    const credentials = new PostgresAppCredentialRepository(database, 'fixture-encryption-key');
    const lifecycle = new PostgresDiscordLifecycleRepository(database);
    const create = async (space, options = {}) => {
      await sql(`INSERT INTO data.space_members VALUES($1,'owner','owner')`, [space]);
      await sql(`INSERT INTO data.app_connector_connections(connection_id,space_id,provider_id,status,version,
        search_rank_sequence,created_by,updated_at) VALUES($1||':discord',$1,'discord','configured',1,$2,'owner',now())`, [space, `${space}-generation`]);
      return install(space, options);
    };
    const install = async (space, options = {}) => {
      const values = { ...fields, ...options.fields };
      const snapshot = options.snapshot ?? await credentials.installationSnapshot({ requestId: crypto.randomUUID(), spaceId: space, actorUserId: 'owner', providerId: 'discord' });
      return (options.repository ?? credentials).put({ requestId: crypto.randomUUID(), spaceId: space, providerId: 'discord', actorUserId: 'owner',
        fields: values, policy, at: new Date().toISOString(), expectedInstallationSnapshot: snapshot,
        oauthInstallation: { appClientId: values.oauthClientId, installationId: values.oauthGuildId,
          eventScopeId: values.oauthUserId, discordAuthorizedAt: options.startedAt ?? started } });
    };
    const event = (extra = {}) => lifecycle.receive({ requestId: crypto.randomUUID(), appClientId: appId, userId,
      type: 'APPLICATION_DEAUTHORIZED', eventAt: revoked, ...extra });
    const resolve = space => credentials.resolve({ requestId: crypto.randomUUID(), spaceId: space, providerId: 'discord' });
    await run({ client, schema, sql, create, install, event, resolve, credentials, lifecycle, database });
  } finally {
    await client.query('ROLLBACK');
    await client.query(`DROP SCHEMA ${schema} CASCADE`); await client.end();
  }
}

integration('Discord native revoke retires only exact current app/Human grants, across their bound Spaces; replay is idempotent', async () => fixture(async f => {
  await f.create('selected'); await f.create('same-human');
  await f.create('other-user', { fields: { oauthUserId: '423456789012345678' } });
  await f.create('other-app', { fields: { oauthClientId: '523456789012345678' } });
  assert.equal((await f.event()).matched, 2);
  for (const space of ['selected', 'same-human']) {
    assert.equal(await f.resolve(space), null);
    assert.deepEqual((await f.sql(`SELECT status,version FROM data.app_connector_connections WHERE space_id=$1`, [space]))[0],
      { status: 'disconnected', version: '3' });
  }
  assert.ok(await f.resolve('other-user')); assert.ok(await f.resolve('other-app'));
  assert.equal((await f.event()).matched, 0);
  assert.equal((await f.sql(`SELECT version FROM data.app_connector_connections WHERE space_id='selected'`))[0].version, '3');
  assert.equal((await f.sql(`SELECT count(*)::int AS n FROM data.app_discord_revocations`))[0].n, 1);
}));

integration('authorization events cannot create, reactivate or cross guild grants; manual edits and credential mismatch remove lifecycle authority', async () => fixture(async f => {
  assert.equal((await f.event({ type: 'APPLICATION_AUTHORIZED', guildId })).matched, 0);
  assert.equal((await f.sql(`SELECT count(*)::int AS n FROM data.app_connector_connections`))[0].n, 0);
  await f.create('chosen');
  assert.equal((await f.event({ type: 'APPLICATION_AUTHORIZED', guildId: '423456789012345678' })).matched, 0);
  assert.equal((await f.event({ type: 'APPLICATION_AUTHORIZED', guildId })).matched, 1);
  await f.sql(`UPDATE data.app_connector_connections SET status='disconnected' WHERE space_id='chosen'`);
  assert.equal((await f.event({ type: 'APPLICATION_AUTHORIZED', guildId })).matched, 0);
  assert.equal((await f.sql(`SELECT status FROM data.app_connector_connections`))[0].status, 'disconnected');
  await f.credentials.put({ requestId: crypto.randomUUID(), spaceId: 'chosen', providerId: 'discord', actorUserId: 'owner',
    fields: { botToken: 'own-bot' }, policy, at: new Date().toISOString() });
  assert.equal((await f.event()).matched, 0); assert.deepEqual((await f.resolve('chosen')).values, { botToken: 'own-bot' });
  await f.create('mismatch', { startedAt: '2026-10-04T20:01:30Z' }); await f.sql(`UPDATE data.app_connector_oauth_installations SET credential_version=999 WHERE space_id='mismatch'`);
  assert.equal((await f.event({ eventAt: '2026-10-04T20:02:00Z' })).matched, 0); assert.ok(await f.resolve('mismatch'));
}));

integration('revocation before callback fences original authorization; new Connect survives old and re-signed replay after reinstall/ABA', async () => fixture(async f => {
  await f.event(); await assert.rejects(f.create('pending'), e => e.code === 'installation_revoked');
  assert.equal(await f.resolve('pending'), null);
  await f.install('pending', { startedAt: '2026-10-04T20:02:00Z' });
  assert.equal((await f.event()).matched, 0); assert.ok(await f.resolve('pending'));
  await f.sql(`DELETE FROM data.app_connector_connections WHERE space_id='pending'`);
  await f.sql(`DELETE FROM data.app_connector_credentials WHERE space_id='pending'`);
  await f.sql(`DELETE FROM data.space_members WHERE space_id='pending'`);
  await f.create('pending', { startedAt: '2026-10-04T20:03:00Z' });
  assert.equal((await f.event()).matched, 0); assert.ok(await f.resolve('pending'));
  await assert.rejects(f.install('pending'), e => e.code === 'installation_revoked');
  assert.ok(await f.resolve('pending'));
}));

function pauseAfterQuery(database, name) {
  let signal, release;
  const reached = new Promise(resolve => { signal = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  return { reached, release, repository: { cacheMode: 'disabled', transaction(context, run) {
    return database.transaction(context, tx => run({ async query(input) {
      const rows = await tx.query(input);
      if (input.name === name) { signal(); await gate; }
      return rows;
    } }));
  } } };
}
async function waitForContendedUserLock(sql) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await sql(`SELECT count(*)::int AS waiting FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE l.locktype='advisory' AND NOT l.granted AND a.datname=current_database()`);
    if (rows[0].waiting > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('the real second transaction did not wait on the current user grant lock');
}

integration('real callback-first and revoke-first contention fence both orders under actual PostgreSQL locks', async () => fixture(async f => {
  await f.create('callback-first');
  const callbackGate = pauseAfterQuery(f.database, 'app_credential_connection_v2');
  const install = f.install('callback-first', { repository: new PostgresAppCredentialRepository(callbackGate.repository, 'fixture-encryption-key') });
  await callbackGate.reached;
  const retire = f.event();
  try { await waitForContendedUserLock(f.sql); } finally { callbackGate.release(); await Promise.allSettled([install, retire]); }
  await install; assert.equal((await retire).matched, 1); assert.equal(await f.resolve('callback-first'), null);

  await f.create('revoke-first', { fields: { oauthUserId: '423456789012345678' } });
  const originalSnapshot = await f.credentials.installationSnapshot({ requestId: crypto.randomUUID(), spaceId: 'revoke-first', actorUserId: 'owner', providerId: 'discord' });
  const revokeGate = pauseAfterQuery(f.database, 'discord_lifecycle_targets_v1');
  const first = new PostgresDiscordLifecycleRepository(revokeGate.repository).receive({ requestId: crypto.randomUUID(),
    appClientId: appId, userId: '423456789012345678', type: 'APPLICATION_DEAUTHORIZED', eventAt: revoked });
  await revokeGate.reached;
  const second = f.install('revoke-first', { snapshot: originalSnapshot, fields: { oauthUserId: '423456789012345678' } });
  // Capture rejection before releasing the gate so node:test sees no unhandled failure.
  const rejected = assert.rejects(second, e => e.code === 'installation_revoked');
  try { await waitForContendedUserLock(f.sql); } finally { revokeGate.release(); await Promise.allSettled([first, second, rejected]); }
  assert.equal((await first).matched, 1); await rejected;
  assert.equal(await f.resolve('revoke-first'), null);
}));

integration('a native rotating refresh retains authorization time; tombstone and current credential versions remain independent', async () => fixture(async f => {
  await f.create('refresh'); const original = await f.resolve('refresh');
  await f.credentials.put({ requestId: crypto.randomUUID(), spaceId: 'refresh', providerId: 'discord', actorUserId: 'hub',
    fields: { oauthToken: 'rotated-access', oauthRefreshToken: 'rotated-refresh' }, policy, at: new Date().toISOString(),
    asHub: true, expectedVersion: original.version });
  assert.equal((await f.sql(`SELECT discord_authorized_at FROM data.app_connector_oauth_installations`))[0].discord_authorized_at.toISOString(), started);
  assert.equal((await f.event()).matched, 1); assert.equal(await f.resolve('refresh'), null);
  await assert.rejects(f.credentials.put({ requestId: crypto.randomUUID(), spaceId: 'refresh', providerId: 'discord', actorUserId: 'hub',
    fields: { oauthToken: 'stale-access' }, policy, at: new Date().toISOString(), asHub: true, expectedVersion: original.version }), e => e.code === 'credential_changed');
}));

integration('Space deletion and grant binding tampering fail closed; invalid identities and cached repositories cannot acquire authority', async () => fixture(async f => {
  await f.create('deleted'); await f.sql(`INSERT INTO data.space_deletions VALUES ('deleted')`);
  assert.equal((await f.event()).matched, 0);
  assert.equal((await f.sql(`SELECT count(*)::int AS n FROM data.app_connector_credentials`))[0].n, 1);
  await assert.rejects(f.event({ userId: 'bad' }), e => e.status === 400);
  assert.throws(() => new PostgresDiscordLifecycleRepository({ cacheMode: 'enabled' }), e => e.status === 500);
  await assert.rejects(f.install('deleted', { fields: { oauthGuildId: 'bad' } }), e => e.status === 404);
}));


integration('fanout overflow rolls back every credential retirement and its watermark instead of partially revoking', async () => fixture(async f => {
  await f.create('bounded');
  await f.sql(`INSERT INTO data.app_connector_connections SELECT 'overflow-'||n||':discord','overflow-'||n,
    provider_id,status,version,'overflow-'||n,created_by,updated_at,last_checked_at,error
    FROM data.app_connector_connections CROSS JOIN generate_series(1,50) n WHERE space_id='bounded'`);
  await f.sql(`INSERT INTO data.app_connector_credentials SELECT 'overflow-'||n||':discord','overflow-'||n,
    field_names_json,encrypted_value_json,version,updated_by,created_at,updated_at
    FROM data.app_connector_credentials CROSS JOIN generate_series(1,50) n WHERE space_id='bounded'`);
  await f.sql(`INSERT INTO data.app_connector_oauth_installations SELECT 'overflow-'||n||':discord','overflow-'||n,
    provider_id,app_client_id,installation_id,credential_version,updated_at,event_scope_id,gen_random_uuid(),discord_authorized_at
    FROM data.app_connector_oauth_installations CROSS JOIN generate_series(1,50) n WHERE space_id='bounded'`);
  await assert.rejects(f.event(), e => e.code === 'too_many_installations');
  assert.equal((await f.sql(`SELECT count(*)::int AS n FROM data.app_connector_credentials`))[0].n, 51);
  assert.equal((await f.sql(`SELECT count(*)::int AS n FROM data.app_discord_revocations`))[0].n, 0);
  assert.equal((await f.sql(`SELECT count(*)::int AS n FROM data.app_connector_connections WHERE status='disconnected'`))[0].n, 0);
}));
