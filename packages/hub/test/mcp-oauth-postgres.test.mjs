import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createAuth } from '../src/better-auth.ts';
import { InvalidAuthTokenError, verifyAuthToken, verifyMcpAccessToken } from '../src/auth.ts';
import { mcpResource } from '../src/mcp-oauth.ts';
import { integration, isolatedPostgres } from '../../db/test/postgres-database.fixture.mjs';

const REDIRECT = 'https://chat.example.test/connector/callback';

async function fixture() {
  const f = await isolatedPostgres('mcp_oauth', { shard: true });
  const env = { AUTH_AUTHORITY: 'postgres', RELAY_POSTGRES: { connectionString: f.url.toString() },
    RELAY_POSTGRES_SHARD_ID: 'shard-0', BETTER_AUTH_SECRET: 'isolated-fixture-signing-secret-not-production',
    APP_URL: 'https://app.mcp.test', HUB_URL: 'https://hub.mcp.test' };
  const auth = createAuth(env);
  const ip = `2001:db8:${f.suffix.slice(0, 4)}:${f.suffix.slice(4, 8)}::1`;
  const call = (path, { method = 'GET', body, form, session } = {}) => auth.handler(new Request(`${env.HUB_URL}/api/auth${path}`, {
    method, headers: { accept: 'application/json', 'cf-connecting-ip': ip, origin: env.APP_URL,
      ...(session ? { authorization: `Bearer ${session}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined,
  }));
  await f.run(`INSERT INTO control.auth_users(id,name,email,email_verified,created_at,updated_at,handle)
    VALUES ('member','Member','member@example.test',true,now(),now(),'member')`);
  const session = randomBytes(24).toString('hex');
  await f.run(`INSERT INTO control.auth_sessions(id,expires_at,token,created_at,updated_at,user_id)
    VALUES ($1, now() + interval '1 day', $2, now(), now(), 'member')`, [randomUUID(), session]);
  return { ...f, env, call, session };
}

/** An outside app registers itself, the member signs in and allows it, and the app trades the code for tokens. */
async function connect(f, scope = 'openid offline_access xmatrix:read') {
  const registered = await f.call('/oauth2/register', { method: 'POST', body: {
    redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', client_name: 'Chat', scope } });
  assert.equal(registered.status, 200, await registered.clone().text());
  const { client_id: clientId } = await registered.json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope,
    state: 'state-1', code_challenge: challenge, code_challenge_method: 'S256', resource: mcpResource(f.env) });
  const asked = await (await f.call(`/oauth2/authorize?${authorize}`, { session: f.session })).json();
  const consentPage = new URL(asked.url);
  assert.equal(consentPage.origin + consentPage.pathname, `${f.env.APP_URL}/oauth/consent`, 'the member is asked first');
  const allowed = await (await f.call('/oauth2/consent', { method: 'POST', session: f.session,
    body: { accept: true, oauth_query: consentPage.search.slice(1) } })).json();
  const back = new URL(allowed.url);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get('state'), 'state-1');
  const tokens = await f.call('/oauth2/token', { method: 'POST', form: { grant_type: 'authorization_code',
    code: back.searchParams.get('code'), code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT } });
  assert.equal(tokens.status, 200, await tokens.clone().text());
  return { clientId, ...(await tokens.json()) };
}

integration('an outside app reaches the MCP endpoint, and only it, with the access the member allowed', async () => {
  const f = await fixture(); try {
    const { clientId, access_token: accessToken, refresh_token: refreshToken } = await connect(f);
    const caller = await verifyMcpAccessToken(accessToken, f.env, mcpResource(f.env));
    assert.equal(caller.user.id, 'member');
    assert.equal(caller.user.email, 'member@example.test');
    assert.equal(caller.clientId, clientId);
    assert.ok(caller.scopes.includes('xmatrix:read'));
    assert.ok(!caller.scopes.includes('xmatrix:write'), 'nothing the member did not allow');

    // The token names the MCP endpoint as its audience: the Hub's own API refuses it,
    // and a resource of another server is not the MCP endpoint.
    await assert.rejects(verifyAuthToken(accessToken, f.env), InvalidAuthTokenError);
    await assert.rejects(verifyMcpAccessToken(accessToken, f.env, 'https://elsewhere.test/mcp'), InvalidAuthTokenError);

    // A refresh token rotates: the new pair works, the spent refresh token does not.
    const refreshed = await f.call('/oauth2/token', { method: 'POST', form: { grant_type: 'refresh_token',
      refresh_token: refreshToken, client_id: clientId, resource: mcpResource(f.env) } });
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
    const renewed = await refreshed.json();
    assert.equal((await verifyMcpAccessToken(renewed.access_token, f.env, mcpResource(f.env))).user.id, 'member');
    // Tokens are kept hashed, never as issued.
    const stored = await f.run('SELECT token FROM control.auth_oauth_refresh_tokens');
    assert.ok(stored.length > 0);
    assert.ok(stored.every(({ token }) => token !== refreshToken && token !== renewed.refresh_token));

    // Replaying a spent refresh token is refused and ends the whole grant, the new pair included.
    const refresh = (token) => f.call('/oauth2/token', { method: 'POST', form: { grant_type: 'refresh_token',
      refresh_token: token, client_id: clientId } });
    assert.notEqual((await refresh(refreshToken)).status, 200, 'a spent refresh token is refused');
    assert.notEqual((await refresh(renewed.refresh_token)).status, 200, 'a replay revokes the grant');
  } finally { await f.close(); }
});

integration('a token request that names no resource still gets a token for the MCP endpoint', async () => {
  const f = await fixture(); try {
    const registered = await (await f.call('/oauth2/register', { method: 'POST', body: {
      redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', scope: 'xmatrix:read' } })).json();
    const verifier = randomBytes(32).toString('base64url');
    const authorize = new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: REDIRECT,
      scope: 'xmatrix:read', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256' });
    const asked = new URL((await (await f.call(`/oauth2/authorize?${authorize}`, { session: f.session })).json()).url);
    const back = new URL((await (await f.call('/oauth2/consent', { method: 'POST', session: f.session,
      body: { accept: true, oauth_query: asked.search.slice(1) } })).json()).url);
    const tokens = await (await f.call('/oauth2/token', { method: 'POST', form: { grant_type: 'authorization_code',
      code: back.searchParams.get('code'), code_verifier: verifier, client_id: registered.client_id, redirect_uri: REDIRECT } })).json();
    assert.equal((await verifyMcpAccessToken(tokens.access_token, f.env, mcpResource(f.env))).user.id, 'member');
  } finally { await f.close(); }
});

integration('a member who denies an app sends it back with access_denied and no code', async () => {
  const f = await fixture(); try {
    const registered = await (await f.call('/oauth2/register', { method: 'POST', body: {
      redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', scope: 'xmatrix:read' } })).json();
    const authorize = new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: REDIRECT,
      scope: 'xmatrix:read', state: 's', code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
      code_challenge_method: 'S256' });
    const asked = new URL((await (await f.call(`/oauth2/authorize?${authorize}`, { session: f.session })).json()).url);
    const back = new URL((await (await f.call('/oauth2/consent', { method: 'POST', session: f.session,
      body: { accept: false, oauth_query: asked.search.slice(1) } })).json()).url);
    assert.equal(back.searchParams.get('error'), 'access_denied');
    assert.equal(back.searchParams.get('code'), null);
  } finally { await f.close(); }
});

integration('without a session the app is sent to sign in on the Web app', async () => {
  const f = await fixture(); try {
    const registered = await (await f.call('/oauth2/register', { method: 'POST', body: {
      redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', scope: 'xmatrix:read' } })).json();
    const authorize = new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: REDIRECT,
      scope: 'xmatrix:read', code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'),
      code_challenge_method: 'S256' });
    const login = new URL((await (await f.call(`/oauth2/authorize?${authorize}`)).json()).url);
    assert.equal(login.origin + login.pathname, `${f.env.APP_URL}/oauth/authorize`);
    assert.equal(login.searchParams.get('client_id'), registered.client_id);
    assert.ok(login.searchParams.get('sig'));
  } finally { await f.close(); }
});

integration('removing an app ends its grant: its refresh token no longer works', async () => {
  const f = await fixture(); try {
    const { clientId, refresh_token: refreshToken } = await connect(f);
    const consents = await (await f.call('/oauth2/get-consents', { session: f.session })).json();
    const consent = consents.find((item) => (item.clientId ?? item.client_id) === clientId);
    assert.ok(consent, JSON.stringify(consents));
    const removed = await f.call('/oauth2/delete-consent', { method: 'POST', session: f.session, body: { id: consent.id } });
    assert.equal(removed.status, 200, await removed.clone().text());
    const refreshed = await f.call('/oauth2/token', { method: 'POST', form: { grant_type: 'refresh_token',
      refresh_token: refreshToken, client_id: clientId } });
    assert.notEqual(refreshed.status, 200);
    assert.equal((await f.run('SELECT count(*)::int n FROM control.auth_oauth_refresh_tokens'))[0].n, 0);
  } finally { await f.close(); }
});
