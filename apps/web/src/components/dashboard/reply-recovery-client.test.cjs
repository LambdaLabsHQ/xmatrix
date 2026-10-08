const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
require('./typescript-require.cjs').installTypeScriptRequire();
const source = fs.readFileSync(`${__dirname}/reply-recovery-client.ts`, 'utf8');
const loaded = { exports: {} };
new Function('exports', 'require', 'module', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(loaded.exports, require, loaded);
const { recoverReply } = loaded.exports;
const input = { channelId: 'channel', bindingId: 'binding', token: 'TOKEN', requestId: 'request' };
test('recovery sends references only and never retries an explicit refusal', async () => {
  const calls = [];
  await assert.rejects(recoverReply(async (url, request) => {
    calls.push({url, request});
    assert.deepEqual(JSON.parse(request.body), {requestId:'request'});
    assert.equal(request.headers.authorization, 'Bearer TOKEN');
    return Response.json({code:'reply_recovery_forbidden'}, {status:403});
  }, input, new AbortController().signal), /original input and its Run owner/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.method, 'POST');
  assert.equal(calls[0].url.endsWith('/recover-reply'), true);
});
test('a mismatched acknowledgement and malformed candidates never become success', async () => {
  await assert.rejects(recoverReply(async () => Response.json({requestId:'other', status:'completed', result:{status:'committed',messageId:'message'}}),
    input, new AbortController().signal), /different request/);
  for (const candidates of [[null, null], [{messageId:'same',createdAt:1},{messageId:'same',createdAt:1}], [{messageId:'one',createdAt:-1},{messageId:'two',createdAt:2}]]) {
    const result = await recoverReply(async () => Response.json({requestId:'request',status:'completed',result:{status:'selection_required',candidates}}), input, new AbortController().signal);
    assert.equal(result.status, 'unavailable');
  }
});
test('selected message references survive the request and response extras are stripped', async () => {
  const result = await recoverReply(async (_url, request) => {
    assert.deepEqual(JSON.parse(request.body), {requestId:'request',messageId:'selected'});
    return Response.json({requestId:'request',status:'completed',result:{status:'committed',messageId:'selected',body:'PRIVATE'}});
  }, {...input,messageId:'selected'}, new AbortController().signal);
  assert.deepEqual(result,{status:'committed',messageId:'selected'});
  const wrong = await recoverReply(async () => Response.json({requestId:'request',status:'completed',result:{status:'committed',messageId:'other'}}),
    {...input,messageId:'selected'}, new AbortController().signal);
  assert.equal(wrong.status, 'unavailable');
});
test('cancellation stops a queued recovery from polling', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(recoverReply(async () => { calls++; controller.abort(new Error('cancelled')); return Response.json({requestId:'request',status:'queued'}); }, input, controller.signal), /cancelled/);
  assert.equal(calls, 1);
});
