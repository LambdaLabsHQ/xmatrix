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
    ...(body ? { body: JSON.stringify(body) } : form ? { body: new URLSearchParams(form).toString() } : {}),
  }));
  await f.run(`INSERT INTO control.auth_users(id,name,email,email_verified,created_at,updated_at,handle)
    VALUES ('member','Member','member@example.test',true,now(),now(),'member')`);
  const session = randomBytes(24).toString('hex');
  await f.run(`INSERT INTO control.auth_sessions(id,expires_at,token,created_at,updated_at,user_id)
    VALUES ($1, now() + interval '1 day', $2, now(), now(), 'member')`, [randomUUID(), session]);
  return { ...f, env, call, session };
}

/** An outside app registers itself (RFC 7591, a public client). */
async function register(f, scope) {
  const registered = await f.call('/oauth2/register', { method: 'POST', body: {
    redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', client_name: 'Chat', scope } });
  assert.equal(registered.status, 200, await registered.clone().text());
  return (await registered.json()).client_id;
}

/** The app asks for the member's authorization; returns where the Hub sends the browser, and the PKCE verifier. */
async function authorize(f, clientId, scope, { resource, signedIn = true } = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope,
    state: 'state-1', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', ...(resource ? { resource } : {}) });
  const asked = await (await f.call(`/oauth2/authorize?${query}`, signedIn ? { session: f.session } : {})).json();
  return { next: new URL(asked.url), verifier };
}

/** The member answers on the consent page; returns where the app is sent back. */
async function answer(f, consentPage, accept) {
  const answered = await (await f.call('/oauth2/consent', { method: 'POST', session: f.session,
    body: { accept, oauth_query: consentPage.search.slice(1) } })).json();
  return new URL(answered.url);
}

/** The whole connection: register, sign in and allow, trade the code for tokens. */
async function connect(f, { scope = 'openid offline_access xmatrix:read', resource = mcpResource(f.env) } = {}) {
  const clientId = await register(f, scope);
  const { next: consentPage, verifier } = await authorize(f, clientId, scope, { resource });
  assert.equal(consentPage.origin + consentPage.pathname, `${f.env.APP_URL}/oauth/consent`, 'the member is asked first');
  const back = await answer(f, consentPage, true);
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
    const { access_token: accessToken } = await connect(f, { scope: 'xmatrix:read', resource: undefined });
    assert.equal((await verifyMcpAccessToken(accessToken, f.env, mcpResource(f.env))).user.id, 'member');
  } finally { await f.close(); }
});

integration('a member who denies an app sends it back with access_denied and no code', async () => {
  const f = await fixture(); try {
    const clientId = await register(f, 'xmatrix:read');
    const back = await answer(f, (await authorize(f, clientId, 'xmatrix:read')).next, false);
    assert.equal(back.searchParams.get('error'), 'access_denied');
    assert.equal(back.searchParams.get('code'), null);
  } finally { await f.close(); }
});

integration('without a session the app is sent to sign in on the Web app', async () => {
  const f = await fixture(); try {
    const clientId = await register(f, 'xmatrix:read');
    const login = (await authorize(f, clientId, 'xmatrix:read', { signedIn: false })).next;
    assert.equal(login.origin + login.pathname, `${f.env.APP_URL}/oauth/authorize`);
    assert.equal(login.searchParams.get('client_id'), clientId);
    assert.ok(login.searchParams.get('sig'));
  } finally { await f.close(); }
});

integration('open registration cannot bypass member consent or obtain a client-credentials token', async () => {
  const f = await fixture(); try {
    const metadata = { redirect_uris: [REDIRECT], client_name: 'xMatrix Security' };
    const bypass = await f.call('/oauth2/register', { method: 'POST', body: { ...metadata, skip_consent: true } });
    assert.equal(bypass.status, 400);
    const service = await f.call('/oauth2/register', { method: 'POST', body: {
      ...metadata, grant_types: ['client_credentials'] } });
    assert.equal(service.status, 400);
    assert.equal((await f.run('SELECT count(*)::int n FROM control.auth_oauth_clients'))[0].n, 0);

    const clientId = await register(f, 'xmatrix:read');
    const { next } = await authorize(f, clientId, 'xmatrix:read');
    assert.equal(next.pathname, '/oauth/consent');
    assert.equal(next.searchParams.get('code'), null);
    const unsigned = new URLSearchParams(next.search);
    unsigned.delete('sig');
    const tampered = new URLSearchParams(next.search);
    tampered.set('redirect_uri', 'https://attacker.example/callback');
    for (const oauthQuery of [unsigned.toString(), tampered.toString()]) {
      const consent = await f.call('/oauth2/consent', { method: 'POST', session: f.session,
        body: { accept: true, oauth_query: oauthQuery } });
      assert.equal(consent.status, 400);
      assert.equal((await consent.json()).error, 'invalid_signature');
    }
    const anonymous = await f.call('/oauth2/consent', { method: 'POST',
      body: { accept: true, oauth_query: next.search.slice(1) } });
    assert.equal(anonymous.status, 401);
    const token = await f.call('/oauth2/token', { method: 'POST', form: {
      grant_type: 'client_credentials', client_id: clientId } });
    assert.notEqual(token.status, 200);
    assert.equal((await f.run('SELECT count(*)::int n FROM control.auth_oauth_consents'))[0].n, 0);
    assert.equal((await f.run('SELECT count(*)::int n FROM control.auth_oauth_access_tokens'))[0].n, 0);
  } finally { await f.close(); }
});

integration('public clients need an exact registered redirect and S256 PKCE before a code can be redeemed', async () => {
  const f = await fixture(); try {
    const clientId = await register(f, 'xmatrix:read');
    const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
      scope: 'xmatrix:read', state: 'state-1' });
    const missingPkce = new URL((await (await f.call(`/oauth2/authorize?${query}`, { session: f.session })).json()).url);
    assert.equal(missingPkce.searchParams.get('error'), 'invalid_request');
    assert.equal(missingPkce.searchParams.get('code'), null);
    query.set('redirect_uri', 'https://attacker.example/callback');
    const wrongRedirect = new URL((await (await f.call(`/oauth2/authorize?${query}`, { session: f.session })).json()).url);
    assert.equal(wrongRedirect.origin, f.env.HUB_URL, 'invalid redirects never receive authorization responses');
    assert.equal(wrongRedirect.searchParams.get('code'), null);

    const back = await answer(f, (await authorize(f, clientId, 'xmatrix:read')).next, true);
    const token = await f.call('/oauth2/token', { method: 'POST', form: { grant_type: 'authorization_code',
      code: back.searchParams.get('code'), code_verifier: randomBytes(32).toString('base64url'),
      client_id: clientId, redirect_uri: REDIRECT } });
    assert.equal(token.status, 401);
    assert.equal((await token.json()).error, 'invalid_request');
    assert.equal((await f.run('SELECT count(*)::int n FROM control.auth_oauth_access_tokens'))[0].n, 0);
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
