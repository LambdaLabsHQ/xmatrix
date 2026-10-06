#!/usr/bin/env node
import { Client } from 'pg';
import { digestCanonicalCloneCborV1, parseAgentRoutingRequirements, parseSpaceAgentRegistrationKey, parseAutoLaunchMentions } from '@xmatrix/protocol';
import { runIfInvoked, withClient } from './cli.mjs';

// Fixed product records only. Authored messages, page revisions, audit evidence,
// credentials and historical command receipts are never rewritten. Launch
// intent digests are recomputed from their cleaned recoverable request.
export const lifecycleCleanupTargets = [
  { table: 'data.runs', keys: ['run_id'], column: 'metadata_json' },
  { table: 'data.agent_launches', keys: ['launch_id'], column: 'spawn_payload_json' },
  { table: 'data.registration_launch_intents', keys: ['actor_user_id', 'command_id'], column: 'launch_request_json', intent: true },
  { table: 'data.machine_daemon_commands', keys: ['command_id'], column: 'payload_json', command: true },
  { table: 'data.automations', keys: ['automation_id'], column: 'payload_json', expressions: true },
];
const retiredKeys = new Set(['oneshot', 'oneShot', 'exitAfterInitialMessage', 'exitAfterInitialTask']);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const retiredPattern = '"(oneshot|oneShot|exitAfterInitialMessage|exitAfterInitialTask|agent_mention_one_shot)"';
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const safeIdPatterns = {
  channel: new RegExp(`^${uuidPattern}$`, 'i'),
  run: new RegExp(`^(?:run:${uuidPattern}|${uuidPattern}:[1-9][0-9]*#[1-9][0-9]*)$`, 'i'),
  message: new RegExp(`^(?:(?:scheduled-message|message):)?${uuidPattern}$`, 'i'),
};
const safeId = (kind, value) => typeof value === 'string' && value.length <= 200 && safeIdPatterns[kind].test(value) ? value : null;

class LifecycleCleanupBlockedError extends Error {
  constructor(preparing, commands, references) {
    super(`Drain retired preparing launches (${preparing}) and pending/leased daemon commands (${commands}) before lifecycle cleanup`);
    this.diagnostics = { status: 'blocked', preparingLaunches: preparing, daemonCommands: commands,
      preparations: references, preparationsTruncated: preparing > references.length };
  }
}

async function preparationReferences(client) {
  const result = await client.query(`SELECT p.run_id,p.channel_id,p.source_message_id,p.created_at,
    EXISTS (SELECT 1 FROM data.runs r WHERE r.run_id=p.run_id) AS has_run
    FROM data.registration_launch_intents p WHERE state='preparing'
      AND launch_request_json::text ~ $1 ORDER BY created_at,run_id LIMIT 10`, [retiredPattern]);
  return result.rows.slice(0, 10).map(row => {
    const created = new Date(row.created_at);
    return { runId: safeId('run', row.run_id), channelId: safeId('channel', row.channel_id),
      sourceMessageId: safeId('message', row.source_message_id),
      createdAt: Number.isFinite(created.getTime()) ? created.toISOString() : null,
      hasRun: typeof row.has_run === 'boolean' ? row.has_run : null };
  });
}

/** Use the product scanner's Markdown and mention boundaries. Only a retired
 * condition in an executable launch's parameter block is removed, never prose,
 * quoted paths, code examples, or a later message paragraph. */
export function cleanLifecycleExpression(body) {
  if (typeof body !== 'string') return body;
  let result = body;
  for (let pass = 0; pass < 128; pass++) {
    const spans = parseAutoLaunchMentions(result).flatMap(mention => {
      const tail = result.slice(mention.end);
      const match = /^[\t\p{Zs}]+oneshot:(?:on|off|"on"|"off")(?=\s|$)/u.exec(tail);
      if (mention.error && match) {
        let suffix = tail;
        let lifetimes = 0;
        const token = /^[\t\p{Zs}]+(repo|pwd|machine|model|effort|harness|launch|oneshot):("(?:[^"]|"")*"|[^\s"]+)(?=\s|$)/u;
        for (let part = token.exec(suffix); part; part = token.exec(suffix)) {
          if (part[1] === 'oneshot' && ++lifetimes > 1) throw new Error('Duplicate retired lifecycle conditions require an owner edit');
          suffix = suffix.slice(part[0].length);
        }
        return [{ start: mention.end, end: mention.end + match[0].length }];
      }
      return [];
    });
    if (!spans.length) {
      // Invalid values and ambiguous retired expressions require an explicit
      // edit by their owner; never erase an invalid constraint and launch.
      if (parseAutoLaunchMentions(result).some(mention => mention.error &&
          /^[\t\p{Zs}]+oneshot:/u.test(result.slice(mention.end)))) {
        throw new Error('Invalid retired lifecycle condition; repair the Automation before cleanup');
      }
      if (result !== body && parseAutoLaunchMentions(result).some(mention => mention.error)) {
        throw new Error('Invalid launch conditions require an owner edit before cleanup');
      }
      return result;
    }
    for (const span of spans.sort((a, b) => b.start - a.start)) result = result.slice(0, span.start) + result.slice(span.end);
  }
  throw new Error('Lifecycle expression exceeds the bounded rewrite limit');
}

function legacyEvidence(value) {
  return record(value) && (record(value.selections) && Object.hasOwn(value.selections, 'oneshot') ||
    Array.isArray(value.choices) && value.choices.some(choice => choice?.key === 'oneshot'));
}

export function cleanLifecycleData(value, expressions = false, depth = 0) {
  if (depth > 32) throw new Error('Lifecycle metadata exceeds the bounded nesting limit');
  if (!record(value)) return structuredClone(value);
  // These are product-owned records, not an arbitrary JSON tree. In particular,
  // App arguments, source-message witnesses and task data are opaque even when
  // they contain a property whose spelling matches a retired product field.
  const next = structuredClone(value);
  for (const key of retiredKeys) delete next[key];
  for (const key of ['parameterEvidence', 'parameters']) {
    // Changing an evaluated question would invalidate its original input digest.
    if (legacyEvidence(next[key])) delete next[key];
  }
  for (const key of ['runMetadata', 'routingDecision', 'repoPool', 'repoPoolBinding', 'tags']) {
    if (record(next[key])) next[key] = cleanLifecycleData(next[key], false, depth + 1);
  }
  if (next.routedAs === 'agent_mention_one_shot') next.routedAs = 'agent_mention';
  if (expressions) {
    for (const path of [['message', 'body'], ['expression', 'text'], ['input', 'datum', 'text']]) {
      let parent = next;
      for (const key of path.slice(0, -1)) parent = record(parent) ? parent[key] : undefined;
      const key = path.at(-1);
      if (record(parent) && typeof parent[key] === 'string') parent[key] = cleanLifecycleExpression(parent[key]);
    }
  }
  return next;
}

export async function launchRequestDigest(value, bodyHash) {
  if (!record(value) || typeof bodyHash !== 'string' || !/^[a-f0-9]{64}$/u.test(bodyHash)) throw new Error('Invalid stored launch request');
  const normalized = { ...value, key: parseSpaceAgentRegistrationKey(value.key),
    requirements: parseAgentRoutingRequirements(value.requirements),
    repositoryAuthorization: value.repositoryAuthorization,
    sourceMessageId: value.sourceMessageId, workspaceReference: value.workspaceReference };
  const { runMetadata: callerMetadata, ...identity } = normalized;
  const { sourceMention: _summon, ...runMetadata } = callerMetadata ?? {};
  return digestCanonicalCloneCborV1({ ...identity, body: bodyHash,
    ...(Object.keys(runMetadata).length ? { runMetadata } : {}) });
}

export async function cleanStoredLifecycles(client, { apply = false, batchSize = 100, maximumRows = 10000 } = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000 ||
      !Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 1000000) throw new Error('Invalid cleanup bounds');
  // Old writers must be stopped before apply. Only in-flight records containing
  // retired data can be affected: unrelated new preparations must keep running.
  // The text predicate is deliberately conservative (it can also match opaque
  // data); it covers every retired key/evidence choice and the old routing tag.
  // Related preparation/claims settle through their owner, never this script.
  const busy = await client.query(`SELECT
    (SELECT COUNT(*) FROM data.registration_launch_intents WHERE state='preparing'
      AND launch_request_json::text ~ $1) AS preparing_launches,
    (SELECT COUNT(*) FROM data.machine_daemon_commands WHERE status IN ('pending','leased')
      AND payload_json::text ~ $1) AS daemon_commands`, [retiredPattern]);
  const preparing = Number(busy.rows[0]?.preparing_launches);
  const commands = Number(busy.rows[0]?.daemon_commands);
  if (![preparing, commands].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Invalid lifecycle cleanup in-flight evidence');
  }
  if (preparing || commands) throw new LifecycleCleanupBlockedError(preparing, commands,
    preparing ? await preparationReferences(client) : []);
  const counts = {};
  let scanned = 0, legacyDigests = 0;
  for (const target of lifecycleCleanupTargets) {
    const { table, keys, column } = target;
    let after;
    let changed = 0;
    for (;;) {
      const values = after ? [...after, batchSize] : [batchSize];
      const cursor = after ? ` AND (${keys.join(',')}) > (${keys.map((_, i) => `$${i + 1}`).join(',')})` : '';
      const rows = await client.query(`SELECT ${keys.join(',')}, ${column} AS value${target.intent ? ", request_digest, source_body_hash" : ""} FROM ${table}
        WHERE ${column} IS NOT NULL${cursor} ORDER BY ${keys.join(',')} LIMIT $${values.length}`, values);
      if (!rows.rows.length) break;
      scanned += rows.rows.length;
      if (scanned > maximumRows) throw new Error('Lifecycle cleanup row budget exhausted; increase the reviewed bound and rerun');
      const updates = [];
      for (const row of rows.rows) {
        const value = cleanLifecycleData(row.value, target.expressions);
        if (JSON.stringify(value) === JSON.stringify(row.value)) continue;
        let requestDigest;
        if (target.intent) {
          // A digest the current formula reproduces is recomputed, so the
          // cleaned request still replays. One an older formula wrote cannot be
          // matched by any current replay either way; it is kept, not refused.
          if (row.request_digest === await launchRequestDigest(row.value, row.source_body_hash)) {
            requestDigest = await launchRequestDigest(value, row.source_body_hash);
          } else {
            requestDigest = row.request_digest;
            legacyDigests += 1;
          }
        }
        updates.push({ row, value, requestDigest });
      }
      if (apply && updates.length) {
        await client.query('BEGIN');
        try {
          await client.query("SET LOCAL lock_timeout = '2s'");
          await client.query("SET LOCAL statement_timeout = '10s'");
          for (const { row, value, requestDigest } of updates) {
            const old = keys.length + 2;
            const extra = target.intent ? [requestDigest, row.request_digest] : [];
            const updated = await client.query(`UPDATE ${table} SET ${column}=$1::jsonb
              ${target.expressions ? ', version=version+1, updated_at=clock_timestamp()' : ''}
              ${target.intent ? `, request_digest=$${old + 1}` : ''}
              WHERE ${keys.map((key, i) => `${key}=$${i + 2}`).join(' AND ')} AND ${column}=$${old}::jsonb${target.intent ? ` AND request_digest=$${old + 2} AND state<>'preparing'` : ''}
                ${target.command ? "AND status NOT IN ('pending','leased')" : ''}`,
            [JSON.stringify(value), ...keys.map(key => row[key]), JSON.stringify(row.value), ...extra]);
            if (updated.rowCount !== 1) throw new Error('Lifecycle cleanup CAS conflict; rerun from a fresh snapshot');
          }
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
      }
      changed += updates.length;
      after = keys.map(key => rows.rows.at(-1)[key]);
    }
    counts[table] = changed;
  }
  return { apply, scanned, changed: counts, legacyDigests };
}

/** The GitHub operator binds each protected URL to its fixed production shard. */
export async function assertCleanupDatabaseIdentity(client, target) {
  const expected = target === 'primary' ? ['xmatrix_prod', 'shard-0']
    : target === 'shard-1' ? ['xmatrix_prod_shard_1', 'shard-1'] : undefined;
  if (!expected) throw new Error('Unknown production cleanup target');
  const result = await client.query('SELECT current_database() AS database, shard_id FROM control.postgres_local_identity');
  if (result.rows.length !== 1 || result.rows[0].database !== expected[0] || result.rows[0].shard_id !== expected[1]) {
    throw new Error('Production cleanup database identity differs');
  }
}

export async function run() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || args.length > 1) throw new Error('Use --dry-run (default) or --apply');
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required');
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000,
    query_timeout: 30000, application_name: 'xmatrix-agent-lifecycle-cleanup' });
  await client.connect();
  const result = await withClient(client, async () => {
    if (process.env.AGENT_LIFECYCLE_CLEANUP_DATABASE !== undefined) {
      await assertCleanupDatabaseIdentity(client, process.env.AGENT_LIFECYCLE_CLEANUP_DATABASE);
    }
    return cleanStoredLifecycles(client, { apply: args.includes('--apply'),
      batchSize: Number(process.env.AGENT_LIFECYCLE_CLEANUP_BATCH_SIZE ?? 100),
      maximumRows: Number(process.env.AGENT_LIFECYCLE_CLEANUP_MAX_ROWS ?? 10000) });
  }).catch(error => {
    if (error instanceof LifecycleCleanupBlockedError) process.stdout.write(`${JSON.stringify(error.diagnostics, null, 2)}\n`);
    throw error;
  });
  // Counts on success; blocked plans contain only bounded, validated record
  // references. Never include prompts, private metadata or credentials.
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
runIfInvoked(import.meta.url, run);
