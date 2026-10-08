import assert from "node:assert/strict";
import test from "node:test";

import {
  decideFirstMessageLaunch,
  executeRegistrationLaunchDispatch,
  executeFirstMessageDecision,
} from "../src/registration-launch-dispatch.ts";

test('composite dispatch persists sanitized rejection through current source and channel authority', async t => {
  const { PostgresRegistrationLaunchRepository } = await import('@xmatrix/db');
  const { digestCanonicalCloneCborV1 } = await import('@xmatrix/protocol');
  const body = '@codex inspect';
  const bodyHash = await digestCanonicalCloneCborV1(body);
  let allowed = true;
  const writes = [];
  t.mock.method(PostgresRegistrationLaunchRepository.prototype, 'dispatchFromMessage', async () => ({
    mode: 'composite', selectionCount: 1, prepared: [], rejected: [
      { selectionIndex: 0, sourceMention: '@codex', code: 'registration_directory_unavailable' },
    ],
  }));
  const database = { cacheMode: 'disabled', transaction: async (_context, callback) => callback({ query: async query => {
    if (query.name === 'channel_space_directory_resolve_v2') return [{ channel_id: 'channel', space_id: 'space', shard_id: 'shard', placement_epoch: 1, entity_version: 1 }];
    if (query.name === 'space_placement_resolve_v1') return [{ space_id: 'space', shard_id: 'shard', placement_epoch: 1, state: 'active', target_shard_id: null, plan_class: 'single' }];
    if (query.name === 'channel_capability_runtime_new_work_v3') return allowed ? [{ channel_id: 'channel', space_id: 'space', mode: 'open', archived_at: null, space_role: 'member' }] : [];
    if (query.name === 'runtime_initial_message_source_v4') return [{ entity_version: 1, body_hash: bodyHash, timeline_sequence: 12 }];
    if (query.name === 'routing_command_lock_v1' || query.name === 'runtime_replay_read_v1') return [];
    if (query.name === 'runtime_replay_write_v1') { writes.push(JSON.parse(query.values[4])); return []; }
    throw new Error(`unexpected ${query.name}`);
  } }) };
  const input = { database, directory: database, commandId: 'dispatch', actorUserId: 'caller', channelId: 'channel', sourceMessageId: 'message', body };
  await executeRegistrationLaunchDispatch(input);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].sourceMessageId, 'message');
  assert.equal(writes[0].rejected[0].code, 'registration_directory_unavailable');
  assert.equal(Object.hasOwn(writes[0], 'bodyHash'), false);
  allowed = false;
  await assert.rejects(executeRegistrationLaunchDispatch(input));
  assert.equal(writes.length, 1);
});

function firstMessageChoices({ chosenBy, claimed = true, deadlineAt = '2026-10-02T00:00:03.000Z' } = {}) {
  const calls = [];
  return { calls, choices: {
    open: async input => { calls.push(['open', input.messageId]); return { deadlineAt, ...(chosenBy ? { chosenBy } : {}) }; },
    recommend: async input => { calls.push(['recommend', input.harness ?? null]); return { deadlineAt }; },
    claim: async input => { calls.push(['claim', input.by, input.harness ?? null]); return { claimed }; },
    fail: async input => { calls.push(['fail', input.failureCode]); },
  } };
}
const firstMessageInput = { commandId: 'new-conversation:m1', actorUserId: 'author', channelId: 'channel', messageId: 'm1' };
const clock = () => Date.parse('2026-10-02T00:00:01.000Z');

test('Jev waits out the author window, then its reading wins the one decision and names the harness', async () => {
  const { calls, choices } = firstMessageChoices();
  const waits = [];
  const decision = await decideFirstMessageLaunch({ ...firstMessageInput, choices, read: async () => 'codex' },
    async ms => { waits.push(ms); }, clock);
  assert.deepEqual(decision, { claimed: true, harness: 'codex' });
  assert.deepEqual(waits, [2_000]);
  assert.deepEqual(calls, [['open', 'm1'], ['recommend', 'codex'], ['claim', 'jev', 'codex']]);
});

test('an author who chose first leaves Jev nothing to summon and nothing to report', async () => {
  for (const state of [{ chosenBy: 'author' }, { claimed: false }]) {
    const { calls, choices } = firstMessageChoices(state);
    assert.deepEqual(await decideFirstMessageLaunch({ ...firstMessageInput, choices, read: async () => 'codex' },
      async () => {}, clock), { claimed: false });
    assert.equal(calls.some(([kind]) => kind === 'fail'), false);
  }
});

test('Jev reading the message as conversation decides "none" once the window closes', async () => {
  const { RegistrationAccessError } = await import('@xmatrix/db');
  const { calls, choices } = firstMessageChoices();
  assert.deepEqual(await decideFirstMessageLaunch({ ...firstMessageInput, choices,
    read: async () => { throw new RegistrationAccessError('start_intent_declined', 409); } }, async () => {}, clock),
  { claimed: true });
  assert.deepEqual(calls, [['open', 'm1'], ['recommend', null], ['claim', 'jev', null]]);
});

test('Jev unable to read the message says why, so the card stops waiting', async () => {
  const { RegistrationAccessError } = await import('@xmatrix/db');
  const { calls, choices } = firstMessageChoices();
  await assert.rejects(decideFirstMessageLaunch({ ...firstMessageInput, choices,
    read: async () => { throw new RegistrationAccessError('registration_not_found', 404); } }, async () => {}, clock),
  error => error.code === 'registration_not_found');
  assert.deepEqual(calls, [['open', 'm1'], ['fail', 'registration_not_found']]);
});

test('an author who saw the card late moves the deadline, and Jev waits for the new one', async () => {
  const { RegistrationAccessError } = await import('@xmatrix/db');
  const { calls, choices } = firstMessageChoices();
  let t = clock();
  let claims = 0;
  choices.claim = async input => {
    calls.push(['claim', input.by, input.harness ?? null]);
    if (++claims === 1) throw new RegistrationAccessError('launch_choice_window_open', 409);
    return { claimed: true };
  };
  choices.open = async input => { calls.push(['open', input.messageId]);
    return { deadlineAt: claims ? '2026-10-02T00:00:05.500Z' : '2026-10-02T00:00:03.000Z' }; };
  const waits = [];
  await decideFirstMessageLaunch({ ...firstMessageInput, choices, read: async () => 'codex' },
    async ms => { waits.push(ms); t += ms; }, () => t);
  assert.deepEqual(waits, [2_000, 2_500]);
  assert.deepEqual(calls, [['open', 'm1'], ['recommend', 'codex'], ['claim', 'jev', 'codex'], ['open', 'm1'],
    ['claim', 'jev', 'codex']]);
});

test("Jev's harness is written as its reading the moment Jev has it, before the parameters are chosen", async () => {
  const { calls, choices } = firstMessageChoices();
  let parametersChosen = false;
  await decideFirstMessageLaunch({ ...firstMessageInput, choices,
    read: async onHarness => {
      await onHarness('codex');
      assert.deepEqual(calls.at(-1), ['recommend', 'codex'], 'the reading is written before the parameters');
      parametersChosen = true;
      return 'codex';
    } }, async () => {}, clock);
  assert.equal(parametersChosen, true);
  assert.equal(calls.filter(([kind]) => kind === 'recommend').length, 1, 'written once');
});


test("an Agent's first-message decision is persisted before its harness can be summoned", async t => {
  const { PostgresRegistrationLaunchRepository, PostgresFirstMessageLaunchChoiceRepository } = await import('@xmatrix/db');
  const { calls, choices } = firstMessageChoices({ deadlineAt: '2020-01-01T00:00:00.000Z' });
  for (const [method, implementation] of Object.entries(choices)) {
    t.mock.method(PostgresFirstMessageLaunchChoiceRepository.prototype, method, implementation);
  }
  t.mock.method(PostgresRegistrationLaunchRepository.prototype, 'readHarnessToStart', async () => 'codex');
  const database = { cacheMode: 'disabled', transaction: async (_context, callback) => callback({ query: async query => {
    if (query.name === 'channel_space_directory_resolve_v2') return [{ channel_id: 'channel', space_id: 'space', shard_id: 'shard', placement_epoch: 1, entity_version: 1 }];
    if (query.name === 'space_placement_resolve_v1') return [{ space_id: 'space', shard_id: 'shard', placement_epoch: 1, state: 'active', target_shard_id: null, plan_class: 'single' }];
    throw new Error(`unexpected ${query.name}`);
  } }) };
  const result = await executeFirstMessageDecision({ ...firstMessageInput, database, directory: database,
    evaluate: async () => { throw new Error('unused'); }, body: 'start an agent', window: false });
  assert.deepEqual(result, { claimed: true, harness: 'codex' });
  assert.deepEqual(calls, [['open', 'm1'], ['recommend', 'codex'], ['claim', 'jev', 'codex']]);
});
