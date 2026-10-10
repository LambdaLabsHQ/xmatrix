import assert from 'node:assert/strict';
import {test} from 'node:test';
import {githubCommitCheckVerdict} from '../src/app-connectors.ts';
import {githubAppEnv,jsonResponse,stubGitHubInstallation} from './support/github-app.mjs';
const env=await githubAppEnv();
const sha='abcdef1234567890';
const completed={status:'completed',latest_check_runs_count:1,updated_at:'2026-10-10T04:28:48Z',app:{slug:'github-actions'}};
async function verdict({head=sha,suites=[completed],runs=[{name:'scan',status:'completed',conclusion:'success'}],total=suites.length,runTotal=runs.length}={}) {
 const github=stubGitHubInstallation({checks:'read',pull_requests:'read',metadata:'read'},call=>{
  if(call.url.endsWith('/pulls/7'))return jsonResponse({head:{sha:head}});
  if(call.url.includes('/check-suites?'))return jsonResponse({total_count:total,check_suites:suites});
  if(call.url.includes('/check-runs?'))return jsonResponse({total_count:runTotal,check_runs:runs});
  return jsonResponse({},404);
 });
 try{return await githubCommitCheckVerdict(env,'777','LambdaLabsHQ','xmatrix',sha,7)}finally{github.restore()}
}
test('queued GitHub Actions CI holds the verdict before its first job exists',async()=>{
 assert.deepEqual(await verdict({suites:[completed,{status:'queued',latest_check_runs_count:0,app:{slug:'github-actions'}}]}),{state:'pending'});
});
test('completed checks on a replaced pull request head cannot wake its opener',async()=>{
 assert.deepEqual(await verdict({head:'new-head'}),{state:'pending'});
});
test('an incomplete suite inventory cannot prove every check passed',async()=>{
 assert.deepEqual(await verdict({total:101}),{state:'pending'});
});
test('completed checks settle while an unused non-Actions app suite stays empty',async()=>{
 assert.deepEqual(await verdict({suites:[completed,{status:'queued',latest_check_runs_count:0,app:{slug:'xmatrix-connector'}}]}),{state:'passed',failed:[],settledAt:completed.updated_at});
});

test('a running check stays pending and a failed check retains its evidence link',async()=>{
 assert.deepEqual(await verdict({runs:[{name:'CI',status:'in_progress',conclusion:null}]}),{state:'pending'});
 assert.deepEqual(await verdict({runs:[{name:'CI',status:'completed',conclusion:'failure',html_url:'https://github.com/acme/app/actions/runs/1'}]}),
  {state:'failed',failed:[{name:'CI',url:'https://github.com/acme/app/actions/runs/1'}],settledAt:completed.updated_at});
});
test('an incomplete check-run inventory cannot settle a complete suite inventory',async()=>{
 assert.deepEqual(await verdict({runTotal:101}),{state:'pending'});
});

test('a workflow cancelled before its first job cannot be hidden by a passing scan',async()=>{
 assert.deepEqual(await verdict({suites:[completed,{status:'completed',conclusion:'cancelled',latest_check_runs_count:0,
  updated_at:completed.updated_at,app:{slug:'github-actions'}}]}),
  {state:'failed',failed:[{name:'GitHub Actions'}],settledAt:completed.updated_at});
});
test('a completed check with no known conclusion cannot prove success',async()=>{
 assert.deepEqual(await verdict({runs:[{name:'CI',status:'completed',conclusion:null}]}),{state:'pending'});
});
