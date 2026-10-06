import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'pg';
import { assertCleanupDatabaseIdentity, cleanLifecycleData, cleanLifecycleExpression, cleanStoredLifecycles, launchRequestDigest, lifecycleCleanupTargets } from '../scripts/agent-lifecycle-cleanup.mjs';

test('cleanup removes only executable lifetime conditions and preserves prose and quoted paths', () => {
  for (const [before, after] of [
    ['@auto repo:o/r oneshot:on audit', '@auto repo:o/r audit'],
    ['@codex oneshot:off pwd:"/work/oneshot:on folder" task', '@codex pwd:"/work/oneshot:on folder" task'],
    ['@auto oneshot:"on" effort:high task', '@auto effort:high task'],
    ['@auto repo:o/r\u3000oneshot:on task\n@claude oneshot:off task', '@auto repo:o/r task\n@claude task'],
    ['`@auto oneshot:on`\n```\n@auto oneshot:on\n```\n> @auto oneshot:on', '`@auto oneshot:on`\n```\n@auto oneshot:on\n```\n> @auto oneshot:on'],
    ['@auto task mentions oneshot:on\noneshot:off', '@auto task mentions oneshot:on\noneshot:off'],
  ]) {
    assert.equal(cleanLifecycleExpression(before), after);
    assert.equal(cleanLifecycleExpression(after), after);
  }
  assert.throws(() => cleanLifecycleExpression('@auto oneshot:maybe task'), /Invalid retired/);
  assert.throws(() => cleanLifecycleExpression('@auto oneshot:on repo:o/r oneshot:off task'), /Duplicate/);
  assert.throws(() => cleanLifecycleExpression('@auto repo:o/r oneshot:on repo:x/y task'), /Invalid launch/);
});

test('cleanup preserves execution and recovery authority and retires unverifiable decision evidence', () => {
  const before = { runId: 'r', executionKey: 'e', resumeSessionKey: 'session', exitAfterInitialMessage: true,
    repoPool: { slotId: 'slot', canonicalRepoIdentity: 'repo', oneShot: true },
    routingDecision: { source: 'jev', rows: [], parameters: { inputDigest: 'digest', selections: { oneshot: 'on' }, choices: [] } },
    prompt: '@auto oneshot:on historical source', privateToken: 'untouched', oneshot: 'off' };
  const next = cleanLifecycleData(before);
  assert.deepEqual(next, { runId: 'r', executionKey: 'e', resumeSessionKey: 'session',
    repoPool: { slotId: 'slot', canonicalRepoIdentity: 'repo' }, routingDecision: { source: 'jev', rows: [] },
    prompt: before.prompt, privateToken: 'untouched' });
  assert.equal(before.exitAfterInitialMessage, true);
  assert.deepEqual(cleanLifecycleData(next), next);
  assert.deepEqual(cleanLifecycleData({ input: { datum: { text: '@auto oneshot:on task' } } }, true),
    { input: { datum: { text: '@auto task' } } });
});

test('cleanup treats App arguments, task data and source witnesses as opaque', () => {
  const opaque = { oneshot: 'user-value', oneShot: true, exitAfterInitialMessage: 'task-data' };
  const before = { oneshot: 'on', runMetadata: { exitAfterInitialMessage: true, privateData: opaque },
    context: { initialMessageSource: opaque },
    input: { datum: { text: '@auto oneshot:on work', appMentions: [{ arguments: opaque }] } } };
  const cleaned = cleanLifecycleData(before, true);
  assert.deepEqual(cleaned, { runMetadata: { privateData: opaque }, context: before.context,
    input: { datum: { text: '@auto work', appMentions: [{ arguments: opaque }] } } });
  assert.equal(before.input.datum.text, '@auto oneshot:on work');
  assert.deepEqual(cleanLifecycleData(cleaned, true), cleaned);
});

test('production URLs must identify the exact database and local shard', async () => {
  const client = rows => ({ query: async () => ({ rows }) });
  await assertCleanupDatabaseIdentity(client([{ database: 'xmatrix_prod', shard_id: 'shard-0' }]), 'primary');
  await assertCleanupDatabaseIdentity(client([{ database: 'xmatrix_prod_shard_1', shard_id: 'shard-1' }]), 'shard-1');
  for (const rows of [[], [{ database: 'test', shard_id: 'shard-0' }],
    [{ database: 'xmatrix_prod', shard_id: 'shard-1' }],
    [{ database: 'xmatrix_prod', shard_id: 'shard-0' }, { database: 'xmatrix_prod', shard_id: 'shard-0' }]]) {
    await assert.rejects(assertCleanupDatabaseIdentity(client(rows), 'primary'), /identity differs/);
  }
  for (const target of ['custom', '__proto__', 'constructor']) {
    await assert.rejects(assertCleanupDatabaseIdentity({ query: async () => assert.fail('unknown target queried a database') }, target), /Unknown/);
  }
});

const url = process.env.XMATRIX_TEST_POSTGRES_URL;
const integration = url || process.env.XMATRIX_REQUIRE_POSTGRES_TEST === 'true' ? test : test.skip;
test('blocked cleanup reports bounded opaque references without leaking payloads or arbitrary identifiers', async () => {
  const uuid = '11111111-1111-4111-8111-111111111111';
  const safe = { run_id: `run:${uuid}`, channel_id: uuid, source_message_id: `scheduled-message:${uuid}`,
    created_at: new Date('2026-01-01T00:00:00Z'), has_run: false, launch_request_json: { privateToken: 'never-log' } };
  let calls = 0;
  const database = { query: async () => ({ rows: ++calls === 1
    ? [{ preparing_launches: '11', daemon_commands: '0' }]
    : [safe, { ...safe, run_id: 'private-token', channel_id: 'private-token', source_message_id: 'private-token',
      created_at: 'private-token', has_run: 'private-token' }, ...Array(10).fill(safe)] }) };
  await assert.rejects(cleanStoredLifecycles(database), error => {
    assert.match(error.message, /Drain retired preparing launches \(11\)/);
    const report = error.diagnostics;
    assert.equal(report.status, 'blocked');
    assert.equal(report.preparations.length, 10);
    assert.equal(report.preparationsTruncated, true);
    assert.deepEqual(report.preparations[0], { runId: `run:${uuid}`, channelId: uuid,
      sourceMessageId: `scheduled-message:${uuid}`, createdAt: '2026-01-01T00:00:00.000Z', hasRun: false });
    assert.deepEqual(report.preparations[1], { runId: null, channelId: null, sourceMessageId: null, createdAt: null, hasRun: null });
    assert.doesNotMatch(JSON.stringify(report), /never-log|private-token|privateToken|launch_request_json/);
    return true;
  });
  assert.equal(calls, 2, 'no write or unbounded scan follows the blocked diagnostic');
});

integration('bounded cleanup previews, applies, replays and fences concurrent changes in PostgreSQL', async () => {
  assert.ok(url);
  const client = new Client({ connectionString: url }); await client.connect();
  const schema = `lifecycle_cleanup_${process.pid}`;
  const sql = (text, values) => client.query(text.replaceAll('data.', `${schema}.`).replaceAll('control.', `${schema}.`), values);
  const database = { query: sql };
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await sql("CREATE TABLE control.postgres_local_identity (shard_id text); INSERT INTO control.postgres_local_identity VALUES ('shard-0')");
    await assert.rejects(assertCleanupDatabaseIdentity(database, 'primary'), /identity differs/,
      'an isolated test database cannot masquerade as production merely by using shard-0');
    for (const { table, keys, column, expressions, intent } of lifecycleCleanupTargets) {
      await sql(`CREATE TABLE ${table} (${keys.map(key => `${key} text`).join(',')}, ${column} jsonb,
        ${keys.includes('run_id') ? '' : 'run_id text,'} channel_id text, source_message_id text, created_at timestamptz DEFAULT now(),
        state text, status text, request_digest text, source_body_hash text, version bigint DEFAULT 1, updated_at timestamptz DEFAULT now(), PRIMARY KEY (${keys.join(',')}))`);
      const value = expressions ? { input: { datum: { text: '@auto repo:o/r oneshot:on work' } } }
        : intent ? { key: { spaceId: 's', ownerUserId: 'o', machineId: 'm', harness: 'codex' },
          requirements: { model: 'm', unattended: false, requiredCapabilities: [] }, oneshot: 'on', commandId: 'cmd' } : { exitAfterInitialMessage: true, runId: 'r', executionKey: 'e' };
      for (const id of ['a', 'b']) await sql(`INSERT INTO ${table} (${keys.join(',')}, ${column}, state, status, request_digest, source_body_hash)
        VALUES (${keys.map((_, i) => `$${i+1}`).join(',')}, $${keys.length+1}, 'committed', 'completed', $${keys.length+2}, $${keys.length+3})`, [...keys.map(() => id), value, intent ? await launchRequestDigest(value, 'a'.repeat(64)) : null, 'a'.repeat(64)]);
    }
    // 'a' was staged under an older digest formula: its digest is kept.
    await sql("UPDATE data.registration_launch_intents SET request_digest=$1 WHERE command_id='a'", ['b'.repeat(64)]);
    const preview = await cleanStoredLifecycles(database, { batchSize: 1 });
    assert.equal(Object.values(preview.changed).reduce((a,b) => a+b), 10);
    assert.equal(preview.legacyDigests, 1);
    assert.equal((await sql('SELECT metadata_json FROM data.runs LIMIT 1')).rows[0].metadata_json.exitAfterInitialMessage, true);
    await cleanStoredLifecycles(database, { apply: true, batchSize: 1 });
    assert.deepEqual((await sql('SELECT metadata_json FROM data.runs LIMIT 1')).rows[0].metadata_json, { runId: 'r', executionKey: 'e' });
    const automation = (await sql('SELECT * FROM data.automations LIMIT 1')).rows[0];
    assert.equal(automation.version, '2');
    const [legacy, intent] = (await sql('SELECT * FROM data.registration_launch_intents ORDER BY command_id')).rows;
    assert.equal(intent.request_digest, await launchRequestDigest(intent.launch_request_json, intent.source_body_hash));
    assert.equal(legacy.request_digest, 'b'.repeat(64), 'an older-formula digest is kept');
    assert.equal(Object.hasOwn(legacy.launch_request_json, 'oneshot'), false);
    assert.equal(automation.payload_json.input.datum.text, '@auto repo:o/r work');
    assert.equal(Object.values((await cleanStoredLifecycles(database, { apply: true })).changed).reduce((a,b) => a+b), 0);
    await sql("UPDATE data.registration_launch_intents SET state='preparing'");
    const preparing = (await sql('SELECT * FROM data.registration_launch_intents ORDER BY command_id')).rows;
    await sql(`UPDATE data.runs SET metadata_json='{"exitAfterInitialMessage":true}'::jsonb WHERE run_id='a'`);
    assert.equal((await cleanStoredLifecycles(database, { apply: true })).changed['data.runs'], 1,
      'an unrelated clean preparation must not prevent retirement elsewhere');
    assert.deepEqual((await sql('SELECT * FROM data.registration_launch_intents ORDER BY command_id')).rows, preparing,
      'active preparation state, requests, digests and ownership remain untouched');
    for (const retired of [
      { oneshot: 'on' }, { oneShot: true }, { exitAfterInitialMessage: true }, { exitAfterInitialTask: true },
      { routedAs: 'agent_mention_one_shot' }, { routingDecision: { parameters: { choices: [{ key: 'oneshot' }] } } },
    ]) {
      await sql("UPDATE data.registration_launch_intents SET launch_request_json=launch_request_json || $1::jsonb WHERE command_id='a'", [retired]);
      await assert.rejects(cleanStoredLifecycles(database, { apply: true }), /Drain retired preparing launches \(1\)/,
        'every retired representation in an active preparation blocks before writing');
      await sql("UPDATE data.registration_launch_intents SET launch_request_json=$1 WHERE command_id='a'", [preparing[0].launch_request_json]);
    }
    await sql("UPDATE data.registration_launch_intents SET state='committed'");
    await sql(`UPDATE data.machine_daemon_commands SET status='pending',payload_json='{"exitAfterInitialMessage":true}'::jsonb WHERE command_id='a'`);
    await assert.rejects(cleanStoredLifecycles(database, { apply: true }), /pending\/leased daemon commands \(1\)/);
    await sql("UPDATE data.machine_daemon_commands SET status='leased' WHERE command_id='a'");
    await assert.rejects(cleanStoredLifecycles(database, { apply: true }), /pending\/leased daemon commands \(1\)/);
    await sql("UPDATE data.machine_daemon_commands SET status='completed' WHERE command_id='a'");
    assert.equal((await cleanStoredLifecycles(database, { apply: true })).changed['data.machine_daemon_commands'], 1);
    await assert.rejects(cleanStoredLifecycles(database, { maximumRows: 1, batchSize: 1 }), /row budget/);
    await sql(`UPDATE data.runs SET metadata_json='{"exitAfterInitialMessage":true}'::jsonb WHERE run_id='a'`);
    const concurrent = new Client({ connectionString: url }); await concurrent.connect();
    try {
      for (const [table, column, stateColumn, active, terminal] of [
        ['registration_launch_intents', 'launch_request_json', 'state', 'preparing', 'committed'],
        ['machine_daemon_commands', 'payload_json', 'status', 'leased', 'completed'],
      ]) {
        const row = (await sql(`SELECT * FROM data.${table} WHERE command_id='a'`)).rows[0];
        const value = { ...row[column], oneshot: 'on' };
        const intent = table === 'registration_launch_intents';
        const digest = intent ? await launchRequestDigest(value, row.source_body_hash) : null;
        await sql(`UPDATE data.${table} SET ${column}=$1${intent ? ', request_digest=$2' : ''} WHERE command_id='a'`,
          intent ? [value, digest] : [value]);
        let activated = false;
        const activating = { query: async (text, values) => {
          if (!activated && text.startsWith(`UPDATE data.${table}`)) {
            activated = true;
            await concurrent.query(`UPDATE ${schema}.${table} SET ${stateColumn}=$1 WHERE command_id='a'`, [active]);
          }
          return sql(text, values);
        } };
        await assert.rejects(cleanStoredLifecycles(activating, { apply: true }), /CAS conflict/,
          'write-time state guards protect a record that becomes active after the preview');
        const retained = (await sql(`SELECT * FROM data.${table} WHERE command_id='a'`)).rows[0];
        assert.deepEqual(retained[column], value);
        assert.equal(retained[stateColumn], active);
        if (intent) assert.equal(retained.request_digest, digest);
        await sql(`UPDATE data.${table} SET ${stateColumn}=$1 WHERE command_id='a'`, [terminal]);
        await cleanStoredLifecycles(database, { apply: true });
      }
    } finally { await concurrent.end(); }
    const editing = new Client({ connectionString: url }); await editing.connect();
    await sql(`UPDATE data.runs SET metadata_json='{"exitAfterInitialMessage":true}'::jsonb WHERE run_id='a'`);
    let raced = false;
    const racing = { query: async (text, values) => {
      if (!raced && text.startsWith('UPDATE data.runs')) {
        raced = true;
        await editing.query(`UPDATE ${schema}.runs SET metadata_json='{"runId":"concurrent"}'::jsonb WHERE run_id='a'`);
      }
      return sql(text, values);
    } };
    try {
      await assert.rejects(cleanStoredLifecycles(racing, { apply: true }), /CAS conflict/);
      assert.deepEqual((await sql("SELECT metadata_json FROM data.runs WHERE run_id='a'")).rows[0].metadata_json, { runId: 'concurrent' });
    } finally { await editing.end(); }
  } finally { await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await client.end(); }
});
