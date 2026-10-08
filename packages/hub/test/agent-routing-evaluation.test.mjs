import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateRoutingChoices,
} from "../src/agent-routing-evaluation.ts";
const input = count => ({ state: { message: 'Fix tests' }, questions: { environment: { type: 'choice',
  instructions: 'Select', criteria: Object.fromEntries(Array.from({ length: count },
    (_, i) => [`candidate_${i}`, JSON.stringify({ harness: 'codex', scheduling: { activeRuns: i, remainingPercent: i } })])) } } });
const answer = (request, selected) => ({ answers: { environment: { choice: selected,
  probabilities: Object.fromEntries(Object.keys(request.questions.environment.criteria).map(key => [key, key === selected ? 1 : 0])) } } });

test('one choice receives all candidates and numerical facts without prerequisite gates', async () => {
  let calls = 0;
  const request = input(100);
  const result = await evaluateRoutingChoices(request, async received => {
    calls++;
    assert.deepEqual(received, request);
    return answer(received, 'candidate_99');
  });
  assert.equal(calls, 1);
  assert.equal(result.environment.choice, 'candidate_99');
});

test('the succeeded record names the model that answered', async () => {
  const events = [];
  const request = input(2);
  const evaluate = Object.assign(async received => ({ ...answer(received, 'candidate_1'), model: 'vendor/router-a' }),
    { recordDecision: async event => { events.push(event); } });
  await evaluateRoutingChoices(request, evaluate);
  assert.deepEqual(events.map(event => [event.status, event.model]), [['started', undefined], ['succeeded', 'vendor/router-a']]);
});

test('an answer outside the finite candidate list is rejected', async () => {
  let calls = 0;
  await assert.rejects(evaluateRoutingChoices(input(2), async request => {
    calls++; return answer(request, 'abstain');
  }), error => error.code === 'invalid_answer' && error.reason === 'invalid_answer');
  assert.equal(calls, 1);
});

test('deadline aborts even an evaluator that ignores its signal', async () => {
  let signal;
  await assert.rejects(evaluateRoutingChoices(input(1), async (_request, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }, { budgetMs: 20 }), error => error.code === 'jev_aborted' && error.reason === 'timeout');
  assert.equal(signal.aborted, true);
});

test('an unclassified provider failure is surfaced without another model call', async () => {
  let calls = 0, signal;
  await assert.rejects(evaluateRoutingChoices(input(100), async (_request, options) => {
    calls++; signal = options.signal; throw new Error('provider failed');
  }), error => error.code === 'jev_evaluation_failed' && error.reason === 'provider_error');
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test('a transient gateway failure retries the identical choice once within its deadline', async () => {
  const received = [];
  const request = input(2);
  const result = await evaluateRoutingChoices(request, async value => {
    received.push(value);
    if (received.length === 1) throw Object.assign(new Error('gateway unavailable'), { code: 'jev_evaluation_failed' });
    return answer(value, 'candidate_1');
  });
  assert.equal(result.environment.choice, 'candidate_1');
  assert.deepEqual(received, [request, request]);
  for (const code of ['jev_auth_failed', 'jev_permission_denied', 'jev_invalid_input']) {
    let calls = 0;
    await assert.rejects(evaluateRoutingChoices(request, async () => {
      calls++;
      throw Object.assign(new Error(code), { code });
    }));
    assert.equal(calls, 1, code);
  }
  let exhausted = 0;
  await assert.rejects(evaluateRoutingChoices(request, async () => {
    exhausted++;
    throw Object.assign(new Error('gateway unavailable'), { code: 'jev_evaluation_failed' });
  }));
  assert.equal(exhausted, 2);
});

test('missing answers and outside choices are rejected', async () => {
  await assert.rejects(evaluateRoutingChoices(input(1), async () => ({ answers: {} })), { code: 'invalid_answer' });
  await assert.rejects(evaluateRoutingChoices(input(1), async request => answer(request, 'outside')), { code: 'invalid_answer' });
});

test('the pick is the answer: its probabilities are kept as given, never judged', async () => {
  // Ten options rounded to two decimals sum to .95, and the pick is not the
  // most probable; the pick still decides.
  const request = input(10);
  const probabilities = Object.fromEntries(Object.keys(request.questions.environment.criteria)
    .map((key, index) => [key, index === 3 ? .14 : .09]));
  const result = await evaluateRoutingChoices(request, async () => ({ answers: { environment: {
    choice: 'candidate_0', probabilities: { ...probabilities, stray: 1 } } } }));
  assert.equal(result.environment.choice, 'candidate_0');
  assert.deepEqual(result.environment.probabilities, probabilities);
  const bare = await evaluateRoutingChoices(input(2), async () => ({ answers: { environment: { choice: 'candidate_1' } } }));
  assert.deepEqual(bare.environment, { choice: 'candidate_1', probabilities: {} });
});

test('invalid answer reports the question key from the request, with a typed validation issue', async () => {
  const request = { state: { task: 'choose' }, questions: { browserMode: {
    type: 'choice', instructions: 'Choose one', criteria: { existing: 'Existing browser' },
  } } };
  await assert.rejects(evaluateRoutingChoices(request, async () => ({ answers: { browserMode: {
    choice: 'invented', probabilities: { existing: 1 },
  } } })), error => error.code === 'invalid_answer' &&
    error.answerFailure?.questionKey === 'browserMode' &&
    error.answerFailure?.issue === 'choice_not_offered');
});

test('invalid budgets and oversized requests spend no calls', async () => {
  for (const budgetMs of [0, -1, 10001, NaN]) {
    await assert.rejects(evaluateRoutingChoices(input(1), async () => assert.fail('invalid budget made a request'), { budgetMs }), /Invalid routing budget/);
  }
  const oversized = input(1);
  oversized.questions.environment.criteria.candidate_0 = 'x'.repeat(65536);
  await assert.rejects(evaluateRoutingChoices(oversized, async () => assert.fail('oversized input made a request')), /exceeds limit/);
});

const tagInput = () => ({ state: { message: 'Review this repository', selectedEnvironment: 'candidate_0' },
  questions: {
    model: { type: 'choice', instructions: 'Select a supported model', criteria: { model_0: 'Model A', model_1: 'Model B' } },
    effort: { type: 'choice', instructions: 'Select supported effort', criteria: { high: 'Detailed', low: 'Brief' } },
  } });
const tagAnswers = () => ({ answers: {
  model: { choice: 'model_1', probabilities: { model_0: .1, model_1: .9 } },
  effort: { choice: 'high', probabilities: { high: .8, low: .2 } },
} });

test('independent tag questions share one request and retain separate distributions', async () => {
  const request = tagInput();
  let calls = 0;
  const result = await evaluateRoutingChoices(request, async received => {
    calls++;
    assert.deepEqual(received, request);
    return tagAnswers();
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, tagAnswers().answers);
  assert.deepEqual(request, tagInput(), 'the message and finite choices are unchanged');
});

test('one missing or invalid tag rejects the whole configuration without retry or defaults', async () => {
  for (const invalid of [undefined, { choice: 'outside', probabilities: { high: .8, low: .2 } }]) {
    let calls = 0;
    await assert.rejects(evaluateRoutingChoices(tagInput(), async () => {
      calls++;
      const result = tagAnswers();
      result.answers.effort = invalid;
      return result;
    }), { code: 'invalid_answer' });
    assert.equal(calls, 1);
  }
});

test('an unsolicited tag cannot become an execution parameter', async () => {
  await assert.rejects(evaluateRoutingChoices(tagInput(), async () => ({ answers: {
    ...tagAnswers().answers, machine: { choice: 'outside', probabilities: { outside: 1 } },
  } })), { code: 'invalid_answer' });
});

test('empty option sets fail before spending a model call', async () => {
  const request = tagInput();
  request.questions.model.criteria = {};
  await assert.rejects(evaluateRoutingChoices(request, async () => assert.fail('no options')), /Invalid routing question/);
});
