import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAuthorityDatabase, PostgresAccountDeletionRepository } from '../../db/dist/index.js';
import { createAuth } from '../src/better-auth.ts';
import { passwordResetEmail } from '../src/auth-password-policy.ts';
import { integration, isolatedPostgres } from '../../db/test/postgres-database.fixture.mjs';
import test from 'node:test';

const password = 'isolated-test-password-46-characters-only';
async function fixture() {
  const f = await isolatedPostgres('auth_password', { shard: true });
  const env = { AUTH_AUTHORITY: 'postgres', RELAY_POSTGRES: { connectionString: f.url.toString() },
    RELAY_POSTGRES_SHARD_ID: 'shard-0', BETTER_AUTH_SECRET: 'isolated-fixture-signing-secret-not-production',
    APP_URL: 'https://app.password.test', HUB_URL: 'https://auth.password.test' };
  const auth = createAuth(env);
  const ip = `2001:db8:${f.suffix.slice(0,4)}:${f.suffix.slice(4,8)}::1`;
  const request = (path, body) => auth.handler(new Request(`${env.HUB_URL}/api/auth${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: env.APP_URL, 'cf-connecting-ip': ip }, body: JSON.stringify(body),
  }));
  await f.run(`INSERT INTO control.auth_users(id,name,email,email_verified,created_at,updated_at,handle)
    VALUES ('reviewer','Reviewer','reviewer@example.test',true,now(),now(),'reviewer'),
      ('unverified','Unverified','unverified@example.test',false,now(),now(),'unverified')`);
  return { ...f, request };
}

integration('password sign-up is disabled and an existing verified identity uses a single-use reset then signs in', async () => {
  const f = await fixture(); try {
    const signup = await f.request('/sign-up/email', { name: 'No', email: 'new@example.test', password });
    assert.equal(signup.ok, false);
    assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_users WHERE email='new@example.test'"))[0].n, 0);
    // No mail binding in this fixture: the actual delivery refusal must be observable,
    // rather than Better Auth swallowing it and returning success.
    await assert.rejects(f.request('/request-password-reset', { email: 'reviewer@example.test', redirectTo: 'https://app.password.test/reset-password' }));
    const rows = await f.run("SELECT identifier FROM control.auth_verifications WHERE value='reviewer' AND identifier LIKE 'reset-password:%'");
    assert.equal(rows.length, 1);
    const token = rows[0].identifier.slice('reset-password:'.length);
    assert.equal((await f.request('/reset-password', { token, newPassword: 'short' })).ok, false);
    assert.equal((await f.request('/reset-password', { token, newPassword: password })).ok, true);
    assert.equal((await f.request('/reset-password', { token, newPassword: password })).ok, false);
    assert.equal((await f.request('/sign-in/email', { email: 'reviewer@example.test', password: 'wrong-password-value' })).ok, false);
    const login = await f.request('/sign-in/email', { email: 'reviewer@example.test', password });
    assert.equal(login.ok, true);
    const payload = await login.json(); assert.equal(payload.user.id, 'reviewer'); assert.ok(payload.token);
    const accounts = await f.run("SELECT provider_id,password FROM control.auth_accounts WHERE user_id='reviewer'");
    assert.equal(accounts.length, 1); assert.equal(accounts[0].provider_id, 'credential');
    assert.notEqual(accounts[0].password, password); assert.ok(accounts[0].password.length > 40);
    const session = (await f.run('SELECT id FROM control.auth_sessions WHERE token=$1', [payload.token]))[0];
    const db = createAuthorityDatabase({connectionString:f.url.toString(),shardId:'shard-0'});
    const deletion = new PostgresAccountDeletionRepository(db,[db],['shard-0']);
    await deletion.begin({userId:'reviewer',sessionId:session.id,email:'reviewer@example.test',requestId:randomUUID(),receiptHash:'a'.repeat(64)});
    await deletion.advance('reviewer',async()=>true);
    assert.equal(await deletion.revoked('reviewer'),true);
    assert.equal((await f.request('/sign-in/email',{email:'reviewer@example.test',password})).ok,false);
    assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_accounts WHERE user_id='reviewer'"))[0].n,0);
  } finally { await f.close(); }
});

integration('password reset rejects a foreign callback before creating a reset credential', async () => {
  const f=await fixture();try{
    const response=await f.request('/request-password-reset',{email:'reviewer@example.test',redirectTo:'https://untrusted.example/reset-password'});
    assert.equal(response.ok,false);
    assert.equal((await f.run("SELECT count(*)::int n FROM control.auth_verifications WHERE identifier LIKE 'reset-password:%'"))[0].n,0);
  }finally{await f.close();}
});

integration('expired reset tokens and unverified mail cannot obtain a password session', async () => {
  const f = await fixture(); try {
    await f.run("INSERT INTO control.auth_verifications(id,identifier,value,expires_at,created_at,updated_at) VALUES('expired','reset-password:expired','reviewer',now()-interval '1 second',now(),now())");
    assert.equal((await f.request('/reset-password', { token: 'expired', newPassword: password })).ok, false);
    await assert.rejects(f.request('/request-password-reset', { email: 'unverified@example.test', redirectTo: 'https://app.password.test/reset-password' }));
    const rows = await f.run("SELECT identifier FROM control.auth_verifications WHERE value='unverified' AND identifier LIKE 'reset-password:%'");
    assert.equal(rows.length, 1);
    assert.equal((await f.request('/reset-password', { token: rows[0].identifier.slice('reset-password:'.length), newPassword: password })).ok, true);
    assert.equal((await f.request('/sign-in/email', { email: 'unverified@example.test', password })).ok, false);
  } finally { await f.close(); }
});


integration('password guesses are rate limited before additional credential checks', async () => {
  const f=await fixture();try{
    for(let i=0;i<5;i++)assert.equal((await f.request('/sign-in/email',{email:'reviewer@example.test',password})).status,401);
    assert.equal((await f.request('/sign-in/email',{email:'reviewer@example.test',password})).status,429);
  }finally{await f.close();}
});

test('password email escapes its private link in HTML and includes expiry without placing secrets in the subject', () => {
  const link = 'https://auth.example.test/reset?token=fake&next="quoted"';
  const mail = passwordResetEmail(link);
  assert.ok(mail.text.includes(link)); assert.ok(mail.html.includes('&amp;')); assert.ok(mail.html.includes('&quot;'));
  assert.ok(mail.text.includes('10 minutes')); assert.equal(mail.subject.includes('fake'), false);
});
