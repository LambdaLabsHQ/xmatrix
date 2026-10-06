import { workflowSourceForJobs } from "./workflow-source.mjs";
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = workflowSourceForJobs(readFileSync(new URL('../.github/workflows/server-release.yml', import.meta.url), 'utf8'), ['hub']);
const script = workflow.match(/node <<'EOF' > "\$secrets_file"\n([\s\S]*?)\n          EOF/)[1];
const base = {
  XMATRIX_SECRET_CATALOG_KEY: 'fixture-key-material-that-is-at-least-32-characters',
};
const run = (extra = {}) => spawnSync(process.execPath, ['-e', script], {
  env: { ...base, ...extra }, encoding: 'utf8',
});

test('missing catalog configuration blocks deployment without emitting secrets', () => {
  const { XMATRIX_SECRET_CATALOG_KEY: _, ...withoutCatalog } = base;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: withoutCatalog, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Missing production secret XMATRIX_SECRET_CATALOG_KEY/);
});

test('configured catalog is preserved exactly and weak configuration fails before deploy', () => {
  const value = 'another-fixture-key-material-that-is-at-least-32-characters';
  const result = run({ XMATRIX_SECRET_CATALOG_KEY: value });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).XMATRIX_SECRET_CATALOG_KEY, value);
  for (const value of ['short', '   ']) {
    const invalid = run({ XMATRIX_SECRET_CATALOG_KEY: value });
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /at least 32 characters/);
  }
});

// Assembled so the fixture never reads as a live key to secret scanners.
const LIVE_FIXTURE_KEY = ['sk', 'live', 'fixtureNotARealKey'].join('_');

const billing = {
  STRIPE_SECRET_KEY: LIVE_FIXTURE_KEY,
  STRIPE_WEBHOOK_SECRET: 'whsec_fixtureNotARealSecret',
  STRIPE_PRO_MONTHLY_PRICE_ID: 'price_fixtureMonthly',
  STRIPE_PRO_ANNUAL_PRICE_ID: 'price_fixtureAnnual',
};

test('Stripe rotation emits a complete live configuration or preserves existing Worker settings', () => {
  const absent = run();
  assert.equal(absent.status, 0, absent.stderr);
  assert.deepEqual(JSON.parse(absent.stdout), base);
  const configured = run(billing);
  assert.equal(configured.status, 0, configured.stderr);
  assert.deepEqual(JSON.parse(configured.stdout), { ...base, ...billing });
});

test('every partial Stripe rotation fails before emitting any secret payload', () => {
  const entries = Object.entries(billing);
  for (let mask = 1; mask < 15; mask++) {
    const partial = Object.fromEntries(entries.filter((_, index) => mask & (1 << index)));
    const result = run(partial);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Missing production billing secret/);
    for (const value of Object.values(partial)) assert.ok(!result.stderr.includes(value));
  }
});

test('test-mode keys, invalid price references, and whitespace cannot reach production', () => {
  for (const override of [
    { STRIPE_SECRET_KEY: 'sk_test_fixtureNotARealKey' },
    { STRIPE_SECRET_KEY: `${LIVE_FIXTURE_KEY}\n` },
    { STRIPE_WEBHOOK_SECRET: '   ' },
    { STRIPE_PRO_MONTHLY_PRICE_ID: 'prod_fixtureProduct' },
    { STRIPE_PRO_ANNUAL_PRICE_ID: 'price_fixtureAnnual ' },
  ]) {
    const result = run({ ...billing, ...override });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /production billing/);
  }
});

const connectorProviders = ['NOTION', 'SLACK', 'LINEAR', 'SENTRY', 'GITLAB', 'JIRA', 'NETLIFY', 'VERCEL', 'GOOGLE', 'BITBUCKET', 'PAGERDUTY', 'CLOUDFLARE'];

test('registered connector applications rotate complete pairs through the deployment payload', () => {
  const connectors = Object.fromEntries(connectorProviders.flatMap((provider) => [
    [`CONNECTOR_${provider}_CLIENT_ID`, `fixture-${provider}-client`],
    [`CONNECTOR_${provider}_CLIENT_SECRET`, `fixture-${provider}-secret`],
  ]));
  connectors.CONNECTOR_SLACK_SIGNING_SECRET = 'fixture-slack-signing-secret';
  connectors.CONNECTOR_LINEAR_SIGNING_SECRET = 'fixture-linear-signing-secret';
  const result = run(connectors);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ...base, ...connectors });
  for (const key of Object.keys(connectors)) {
    assert.ok(workflow.includes(key + ': ${{ secrets.' + key + ' }}'), `${key} must reach the deployment step`);
  }
});

test('partial connector rotations fail without emitting secrets or exposing their values', () => {
  for (const provider of connectorProviders) {
    for (const suffix of ['CLIENT_ID', 'CLIENT_SECRET']) {
      const value = `fixture-private-${provider}-${suffix}`;
      const result = run({ [`CONNECTOR_${provider}_${suffix}`]: value });
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Missing production connector secret/);
      assert.ok(!result.stderr.includes(value));
    }
  }
});

test('Sentry Public Integration identity requires both identifiers and the canonical client pair', () => {
  const app = { CONNECTOR_SENTRY_CLIENT_ID: 'fixture-sentry-client', CONNECTOR_SENTRY_CLIENT_SECRET: 'fixture-sentry-secret',
    CONNECTOR_SENTRY_APP_UUID: '11111111-2222-4333-8444-555555555555', CONNECTOR_SENTRY_APP_SLUG: 'xmatrix' };
  const accepted = run(app);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout), { ...base, ...app });
  for (const key of Object.keys(app)) assert.ok(workflow.includes(key + ': ${{ secrets.' + key + ' }}'));
  for (const change of [{ CONNECTOR_SENTRY_APP_UUID: '' }, { CONNECTOR_SENTRY_APP_SLUG: '' },
    { CONNECTOR_SENTRY_CLIENT_ID: '', CONNECTOR_SENTRY_CLIENT_SECRET: '' },
    { CONNECTOR_SENTRY_APP_UUID: 'not-a-uuid' }, { CONNECTOR_SENTRY_APP_SLUG: '../other' }]) {
    const rejected = run({ ...app, ...change });
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.stdout, '');
    assert.ok(!rejected.stderr.includes(app.CONNECTOR_SENTRY_CLIENT_SECRET));
  }
});

test('Google Picker parameters require a complete application and public configuration pair', () => {
  const google = { CONNECTOR_GOOGLE_CLIENT_ID: 'fixture-google-client', CONNECTOR_GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
    CONNECTOR_GOOGLE_PICKER_API_KEY: 'fixture_public_picker_key_123456', CONNECTOR_GOOGLE_PICKER_APP_ID: '218762573462' };
  const valid = run(google);
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), { ...base, ...google });
  for (const overrides of [
    { CONNECTOR_GOOGLE_PICKER_APP_ID: '' }, { CONNECTOR_GOOGLE_PICKER_API_KEY: '' },
    { CONNECTOR_GOOGLE_CLIENT_ID: '', CONNECTOR_GOOGLE_CLIENT_SECRET: '' },
    { CONNECTOR_GOOGLE_PICKER_APP_ID: 'invalid' }, { CONNECTOR_GOOGLE_PICKER_API_KEY: 'short' },
  ]) {
    const result = run({ ...google, ...overrides });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(google.CONNECTOR_GOOGLE_CLIENT_SECRET));
  }
});

test('URLs copied instead of connector secrets and whitespace fail before any deployment', () => {
  for (const value of ['https://example.invalid/oauth/authorize?client_id=fixture', ' fixture-secret', 'fixture\nsecret', '   ']) {
    const result = run({ CONNECTOR_NOTION_CLIENT_ID: 'fixture-client', CONNECTOR_NOTION_CLIENT_SECRET: value });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /production connector secret/);
    if (value.trim()) assert.ok(!result.stderr.includes(value));
  }
});


const chatAccount = { type: 'service_account', project_id: 'fixture-project',
  client_email: 'fixture@fixture-project.iam.gserviceaccount.com', private_key_id: 'a'.repeat(40),
  private_key: '-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n',
  token_uri: 'https://oauth2.googleapis.com/token', universe_domain: 'googleapis.com' };
const chatConfiguration = { CONNECTOR_GOOGLECHAT_SERVICE_ACCOUNT_JSON: JSON.stringify(chatAccount),
  CONNECTOR_GOOGLECHAT_APP_ID: '218762573462',
  CONNECTOR_GOOGLECHAT_SYSTEM_SERVICE_ACCOUNT_EMAIL: 'service-218762573462@gcp-sa-gsuiteaddons.iam.gserviceaccount.com' };

test('Google Chat native deployment rotates all three exact identities or preserves absent configuration', () => {
  const accepted = run(chatConfiguration);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout), { ...base, ...chatConfiguration });
  for (const key of Object.keys(chatConfiguration)) assert.ok(workflow.includes(key + ': ${{ secrets.' + key + ' }}'));
  const entries = Object.entries(chatConfiguration);
  for (let mask = 1; mask < 7; mask++) {
    const result = run(Object.fromEntries(entries.filter((_, index) => mask & (1 << index))));
    assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(chatAccount.private_key));
  }
});

test('Google Chat deployment rejects a changed system identity, URL, invalid JSON or wrong key account without exposing configuration', () => {
  const changes = [{ CONNECTOR_GOOGLECHAT_SYSTEM_SERVICE_ACCOUNT_EMAIL: 'chat@system.gserviceaccount.com' },
    { CONNECTOR_GOOGLECHAT_APP_ID: 'https://attacker.invalid' }, { CONNECTOR_GOOGLECHAT_SERVICE_ACCOUNT_JSON: '{ private configuration' },
    ...[{ type: 'authorized_user' }, { client_email: 'fixture@other-project.iam.gserviceaccount.com' },
      { token_uri: 'https://attacker.invalid/token' }, { universe_domain: 'attacker.invalid' }, { private_key: '' },
      { private_key_id: 'not-an-id' }].map(change => ({ CONNECTOR_GOOGLECHAT_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...chatAccount, ...change }) }))];
  for (const change of changes) {
    const rejected = run({ ...chatConfiguration, ...change });
    assert.notEqual(rejected.status, 0); assert.equal(rejected.stdout, '');
    assert.ok(!rejected.stderr.includes('private configuration'));
    assert.ok(!rejected.stderr.includes(chatAccount.private_key));
  }
});


test('Discord company application deploys only a complete bounded client and bot triple', () => {
  const values = { CONNECTOR_DISCORD_CLIENT_ID: '123456789012345678', CONNECTOR_DISCORD_CLIENT_SECRET: 'fixture-client',
    CONNECTOR_DISCORD_BOT_TOKEN: 'fixture-bot' };
  const complete = run(values); assert.equal(complete.status, 0, complete.stderr);
  for (const [key, value] of Object.entries(values)) assert.equal(JSON.parse(complete.stdout)[key], value);
  for (const key of Object.keys(values)) {
    const partial = { ...values }; delete partial[key]; const result = run(partial);
    assert.notEqual(result.status, 0); assert.equal(result.stdout, ''); assert.doesNotMatch(result.stderr, /fixture-client|fixture-bot/);
  }
  for (const extra of [{ CONNECTOR_DISCORD_CLIENT_ID: 'not-a-snowflake' }, { CONNECTOR_DISCORD_BOT_TOKEN: 'x'.repeat(4097) }]) {
    const invalid = run({ ...values, ...extra }); assert.notEqual(invalid.status, 0); assert.equal(invalid.stdout, '');
  }
});

const feishuConfiguration = { CONNECTOR_FEISHU_APP_ID: 'cli_fixture1234', CONNECTOR_FEISHU_APP_SECRET: 'fixture-app-secret',
  CONNECTOR_FEISHU_VERIFICATION_TOKEN: 'fixture-verification', CONNECTOR_FEISHU_ENCRYPT_KEY: 'fixture-encryption' };
test('Feishu store app configuration is optional and rotates only as a complete bounded group', () => {
  assert.equal(run().status, 0);
  const configured = run(feishuConfiguration); assert.equal(configured.status, 0, configured.stderr);
  assert.deepEqual(JSON.parse(configured.stdout), { ...base, ...feishuConfiguration });
  const entries = Object.entries(feishuConfiguration);
  for (let mask=1; mask<15; mask++) {
    const result = run(Object.fromEntries(entries.filter((_, i) => mask & (1<<i))));
    assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
    for (const value of Object.values(feishuConfiguration)) assert.ok(!result.stderr.includes(value));
  }
  for (const [key] of entries) for (const value of ['unsafe value', 'x'.repeat(257), 'https://attacker.invalid']) {
    const result = run({ ...feishuConfiguration, [key]: value }); assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
  }
});

test('Telegram company deployment emits only the complete validated pair and redacts failure output', () => {
  const pair = { CONNECTOR_TELEGRAM_BOT_TOKEN: `123456:${'t'.repeat(35)}`, CONNECTOR_TELEGRAM_WEBHOOK_SECRET: 'fixture_header_'.repeat(4) };
  const configured = run(pair);
  assert.equal(configured.status, 0, configured.stderr); assert.deepEqual(JSON.parse(configured.stdout), { ...base, ...pair });
  for (const selected of Object.keys(pair)) {
    const partial = run({ [selected]: pair[selected] }); assert.notEqual(partial.status, 0);
    assert.equal(partial.stdout, ''); assert.ok(!partial.stderr.includes(pair[selected]));
    for (const value of ['with space', 'x'.repeat(257), 'https://wrong.invalid', 'newline\nvalue']) {
      const invalid = run({ ...pair, [selected]: value }); assert.notEqual(invalid.status, 0); assert.equal(invalid.stdout, '');
    }
  }
  const unsafeId = run({ ...pair, CONNECTOR_TELEGRAM_BOT_TOKEN: `9999999999999999:${'t'.repeat(35)}` }); assert.notEqual(unsafeId.status, 0);
});

function assertCompanySuiteConfiguration(fields) {
  const configured = run(fields); assert.equal(configured.status,0,configured.stderr);
  assert.deepEqual(JSON.parse(configured.stdout),{...base,...fields});
  const entries=Object.entries(fields);
  for(let mask=1;mask<15;mask++) {
    const partial=run(Object.fromEntries(entries.filter((_,i)=>mask&(1<<i))));
    assert.notEqual(partial.status,0);assert.equal(partial.stdout,'');
    for(const value of Object.values(fields))assert.ok(!partial.stderr.includes(value));
  }
  for(const [key] of entries) for(const value of ['unsafe\nvalue','https://wrong.invalid','x'.repeat(257)]) {
    const invalid=run({...fields,[key]:value});assert.notEqual(invalid.status,0);assert.equal(invalid.stdout,'');
  }
  const aesKey=entries.find(([name])=>name.endsWith('_ENCODING_AES_KEY'))[0];
  assert.notEqual(run({...fields,[aesKey]:'x'.repeat(43)}).status,0);
}
test('WeCom suite deployment validates every credential before emitting any production secret', () => {
  assertCompanySuiteConfiguration({ CONNECTOR_WECOM_SUITE_ID: 'ww0123456789abcdef', CONNECTOR_WECOM_SUITE_SECRET: 'public_fixture_secret',
    CONNECTOR_WECOM_CALLBACK_TOKEN: 'PublicFixtureToken', CONNECTOR_WECOM_ENCODING_AES_KEY: Buffer.alloc(32,7).toString('base64').slice(0,-1) });
});
test('DingTalk suite configuration is complete, canonical and private before production secret output', () => {
  assertCompanySuiteConfiguration({ CONNECTOR_DINGTALK_SUITE_KEY: 'suiteFixtureKey', CONNECTOR_DINGTALK_SUITE_SECRET: 'public_fixture_secret',
    CONNECTOR_DINGTALK_CALLBACK_TOKEN: 'PublicFixtureToken', CONNECTOR_DINGTALK_ENCODING_AES_KEY: Buffer.alloc(32,9).toString('base64').slice(0,-1) });
});


test('Discord webhook public key is optional for the company triple and requires complete matching application configuration', () => {
  const triple = { CONNECTOR_DISCORD_CLIENT_ID: '123456789012345678', CONNECTOR_DISCORD_CLIENT_SECRET: 'fixture-client',
    CONNECTOR_DISCORD_BOT_TOKEN: 'fixture-bot' };
  const key = 'ab'.repeat(32);
  const configured = run({ ...triple, CONNECTOR_DISCORD_PUBLIC_KEY: key });
  assert.equal(configured.status, 0, configured.stderr);
  assert.equal(JSON.parse(configured.stdout).CONNECTOR_DISCORD_PUBLIC_KEY, key);
  for (const config of [{ CONNECTOR_DISCORD_PUBLIC_KEY: key },
    ...['bad', 'ab'.repeat(31), 'ab'.repeat(33), 'Z'.repeat(64)].map(value => ({ ...triple, CONNECTOR_DISCORD_PUBLIC_KEY: value }))]) {
    const invalid = run(config); assert.notEqual(invalid.status, 0); assert.equal(invalid.stdout, '');
    assert.doesNotMatch(invalid.stderr, /fixture-client|fixture-bot/);
  }
});

test('Teams canonical company credentials require all three fields and never print a rejected value', () => {
  const fields = { CONNECTOR_TEAMS_APP_ID: '11111111-1111-4111-8111-111111111111',
    CONNECTOR_TEAMS_TENANT_ID: '22222222-2222-4222-8222-222222222222', CONNECTOR_TEAMS_APP_SECRET: 'private-teams-fixture' };
  assert.deepEqual(JSON.parse(run(fields).stdout), { ...base, ...fields });
  const entries = Object.entries(fields);
  const invalid = [ ...Array.from({ length: 6 }, (_, i) => Object.fromEntries(entries.filter((_, j) => (i + 1) & (1 << j)))),
    { ...fields, CONNECTOR_TEAMS_APP_ID: 'personal-MSA' }, { ...fields, CONNECTOR_TEAMS_TENANT_ID: 'common' },
    { ...fields, CONNECTOR_TEAMS_APP_SECRET: 'bad secret' }, { ...fields, CONNECTOR_TEAMS_APP_SECRET: 'x'.repeat(257) } ];
  for (const values of invalid) {
    const failed = run(values);
    assert.ok(failed.status !== 0 && failed.stdout === '', 'partial or invalid Teams configuration must fail before output');
    assert.doesNotMatch(failed.stderr, /private-teams-fixture/);
  }
  assert.ok(entries.every(([key]) => workflow.includes(key + ': ${{ secrets.' + key + ' }}')));

});
test('DingTalk company routes require explicit suite-ticket SyncHTTP console and approved template metadata',()=>{
  const suite={CONNECTOR_DINGTALK_SUITE_KEY:'suiteFixtureKey',CONNECTOR_DINGTALK_SUITE_SECRET:'public_fixture_secret',
    CONNECTOR_DINGTALK_CALLBACK_TOKEN:'PublicFixtureToken',CONNECTOR_DINGTALK_ENCODING_AES_KEY:Buffer.alloc(32,9).toString('base64').slice(0,-1)};
  const config={protocol:'suite-ticket',delivery:'sync-http',suiteId:'1234567',developerCorpId:'dingDeveloperFixture',appId:34576,templateId:'ApprovedFixture',templateField:'text'};
  const value=JSON.stringify(config),valid=run({...suite,CONNECTOR_DINGTALK_COMPANY_CONFIG:value});
  assert.equal(valid.status,0,valid.stderr);assert.equal(JSON.parse(valid.stdout).CONNECTOR_DINGTALK_COMPANY_CONFIG,value);
  for(const invalid of [JSON.stringify({...config,protocol:'client-credentials'}),JSON.stringify({...config,delivery:'stream'}),
    JSON.stringify({...config,suiteId:'suiteKeyIsNotSuiteId'}),JSON.stringify({...config,templateId:''}),JSON.stringify({...config,appId:1.5}),
    JSON.stringify({...config,unknown:true}),value.replace('"suite-ticket"','"suite-ticket","protocol":"suite-ticket"')]) {
    const result=run({...suite,CONNECTOR_DINGTALK_COMPANY_CONFIG:invalid});assert.notEqual(result.status,0);assert.equal(result.stdout,'');
  }
  assert.notEqual(run({CONNECTOR_DINGTALK_COMPANY_CONFIG:value}).status,0);
});
