import assert from 'node:assert/strict';
import test from 'node:test';
import {
  withSummonDecisionContent,
  withDecisionClock,
} from "../src/summon-decision-content.ts";
import {
  evaluateRoutingChoices,
  RoutingEvidenceUnavailable,
} from "../src/agent-routing-evaluation.ts";
const request = { state: { message: 'original  message', privateDirectory: '/private/project' },
  questions: { environment: { type: 'choice', instructions: 'Select one.', criteria: { candidate_0: 'Only environment' } } } };
const valid = { answers: { environment: { choice: 'candidate_0', probabilities: { candidate_0: 1 } } } };

function fixture(evaluate, { failStorage = false, failIntentOnce = false, failCommitOnce = false } = {}) {
  const blobs = [], refs = [], order = [], intents = [], commits = [];
  const content = {
    async createIntent(input) { order.push('intent'); intents.push(input);
      if (failStorage || (failIntentOnce && intents.length === 1)) throw new Error('storage unavailable'); return input; },
    async commitRef(input) { order.push('commit'); commits.push(input);
      if (failCommitOnce && commits.length === 1) throw new Error('storage unavailable');
      refs.push(input); return input; },
  };
  const bucket = { async head() { return null; }, async put(key, body, options) {
    const bytes = await new Response(body).arrayBuffer();
    blobs.push({ key, payload: JSON.parse(new TextDecoder().decode(bytes)) }); order.push('upload');
    return { size: bytes.byteLength, etag: 'verified', checksums: { sha256: await crypto.subtle.digest('SHA-256', bytes) }, customMetadata: options.customMetadata };
  } };
  return { blobs, refs, order, intents, commits, evaluate: withSummonDecisionContent({ evaluate: async (...args) => {
    order.push('model'); return evaluate(...args);
  }, content, bucket, actorUserId: 'user', channelId: 'channel', sourceMessageId: 'source', invocationId: 'summon-one' }) };
}

test('exact input is committed before model invocation and validated choices are stored separately', async () => {
  const f = fixture(async input => { assert.deepEqual(input, request); return valid; });
  const answers = await evaluateRoutingChoices(request, f.evaluate);
  assert.deepEqual(f.order, ['intent', 'upload', 'commit', 'model', 'intent', 'upload', 'commit']);
  assert.deepEqual(f.blobs[0].payload.input, request);
  assert.deepEqual(f.blobs[1].payload.answers, answers);
  assert.equal(f.blobs[0].payload.decisionId, f.blobs[1].payload.decisionId);
  assert.equal(f.blobs[0].payload.sourceMessageId, 'source');
  assert.match(f.blobs[0].payload.inputDigest, /^[a-f0-9]{64}$/);
  assert.ok(f.blobs.every(blob => blob.key.startsWith('restricted/')));
  assert.ok(f.refs.every(ref => ref.ownerKind === 'summon_decision' && ref.ownerId === 'source' && ref.scopeId === 'channel-user:channel:user'));
});

test('provider failure and invalid answers retain only safe failure categories', async () => {
  for (const [evaluate, reason] of [
    [async () => { throw new Error('private provider response'); }, 'provider_error'],
    [async () => ({ answers: { environment: { choice: 'private provider response' } } }), 'invalid_answer'],
  ]) {
    const f = fixture(evaluate);
    await assert.rejects(evaluateRoutingChoices(request, f.evaluate));
    assert.equal(f.blobs.length, 2);
    assert.equal(f.blobs[1].payload.status, 'failed');
    assert.equal(f.blobs[1].payload.reason, reason);
    assert.equal(f.blobs[1].payload.code, reason === 'invalid_answer' ? 'invalid_answer' : 'jev_evaluation_failed');
    if (reason === 'invalid_answer') assert.deepEqual(f.blobs[1].payload.answerFailure,
      { questionKey: 'environment', issue: 'choice_not_offered' });
    assert.doesNotMatch(JSON.stringify(f.blobs), /private provider response/);
  }
});

test('a recovered transient provider error retains one started and one succeeded decision', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('private transient failure'), { code: 'jev_evaluation_failed' });
    return valid;
  });
  const answers = await evaluateRoutingChoices(request, f.evaluate);
  assert.equal(calls, 2);
  assert.deepEqual(answers, valid.answers);
  assert.deepEqual(f.blobs.map(blob => blob.payload.status), ['started', 'succeeded']);
  assert.equal(f.blobs[0].payload.decisionId, f.blobs[1].payload.decisionId);
  assert.doesNotMatch(JSON.stringify(f.blobs), /private transient failure/u);
});

test('a model ignoring cancellation still produces a durable timeout result', async () => {
  const f = fixture(async () => new Promise(() => {}));
  await assert.rejects(evaluateRoutingChoices(request, f.evaluate, { budgetMs: 5 }));
  assert.equal(f.blobs[1].payload.reason, 'timeout');
  assert.equal(f.blobs[1].payload.code, 'jev_aborted');
});

test('failed input storage prevents an unobservable model invocation', async () => {
  const f = fixture(async () => valid, { failStorage: true });
  await assert.rejects(evaluateRoutingChoices(request, f.evaluate), error => error instanceof RoutingEvidenceUnavailable && error.phase === "started" && error.stage === "intent");
  assert.deepEqual(f.order, ['intent', 'intent']);
});

test('a transient evidence failure retries the same idempotent step without repeating a model choice', async () => {
  const f = fixture(async () => valid, { failIntentOnce: true, failCommitOnce: true });
  await evaluateRoutingChoices(request, f.evaluate);
  assert.deepEqual(f.intents[0], f.intents[1]);
  assert.deepEqual(f.commits[0], f.commits[1]);
  assert.equal(f.order.filter(step => step === 'model').length, 1);
  assert.equal(f.blobs.length, 2);
});

for (const outcome of ['succeeded', 'failed']) {
  test(`failed ${outcome} evidence storage cannot return a usable decision`, async () => {
    const statuses = [];
    const evaluate = Object.assign(async () => {
      if (outcome === 'failed') throw new Error('private provider payload');
      return valid;
    }, { recordDecision: async event => {
      statuses.push(event.status);
      if (event.status !== 'started') throw new Error('private storage payload');
    } });
    await assert.rejects(evaluateRoutingChoices(request, evaluate), error => {
      assert.ok(error instanceof RoutingEvidenceUnavailable);
      assert.equal(error.phase, outcome);
      assert.doesNotMatch(String(error), /private/);
      return true;
    });
    assert.deepEqual(statuses, ['started', outcome]);
  });
}

test('evidence failures name the failing step without leaking the underlying error', async () => {
  const event = { decisionId: 'd1', at: new Date(0).toISOString(), status: 'started', input: request };
  const stored = [];
  const recorder = failing => withDecisionClock(async e => { stored.push(e.status); }, async () => {
    if (failing === 'resolve') throw new Error('private route payload');
    return { async arm() { if (failing === 'arm') throw new Error('private arm payload'); } };
  });
  for (const [failing, stage] of [['resolve', 'clock_resolve'], ['arm', 'clock_arm']]) {
    const evaluate = Object.assign(async () => valid, { recordDecision: recorder(failing) });
    await assert.rejects(evaluateRoutingChoices(request, evaluate), error => {
      assert.ok(error instanceof RoutingEvidenceUnavailable);
      assert.equal(error.stage, stage);
      assert.doesNotMatch(String(error), /private/);
      return true;
    });
  }
  assert.deepEqual(stored, []);
  await recorder()(event);
  assert.deepEqual(stored, ['started']);
});

test('a re-arm failure after the evidence is durable does not reject the decision', async () => {
  const stored = [];
  let arms = 0;
  const evaluate = Object.assign(async () => valid, { recordDecision: withDecisionClock(
    async event => { stored.push(event.status); },
    async () => ({ async arm() { arms++; if (stored.length > 0 && arms % 3 !== 1) throw new Error('arm down'); } })) });
  const choices = await evaluateRoutingChoices(request, evaluate);
  assert.equal(choices.environment.choice, 'candidate_0');
  assert.deepEqual(stored, ['started', 'succeeded']);
});
