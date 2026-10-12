import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { json, MOCK_TOKEN, randomUUID, startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";

const REDIRECT = "https://chat.example.test/connector/callback";
const APP = "https://xmatrix.test";

// An outside AI app finds the MCP endpoint, signs the member in through OAuth
// and reads their Space's pages with the member's own access.
test("an outside app connects over OAuth and reads the member's pages through MCP", async () => {
  const userId = `mcp-${randomUUID()}`;
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN, XMATRIX_MOCK_AUTH_USER_ID: userId,
    XMATRIX_MOCK_AUTH_EMAIL: "mcp@example.com", XMATRIX_MOCK_AUTH_NAME: "Mcp Member",
  } });
  const db = new pg.Client({ connectionString: worker.postgresUrl });
  await db.connect();
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const space = (await json(await worker.fetch("/api/spaces", { method: "POST", headers: auth,
      body: JSON.stringify({ name: `Mcp ${randomUUID()}` }) }))).space;
    const pages = `/api/spaces/${encodeURIComponent(space.id)}/pages`;
    const roadmap = (await json(await worker.fetch(pages, { method: "POST", headers: auth,
      body: JSON.stringify({ title: "Roadmap", body: "# Roadmap\n\nShip the MCP server.\n" }) }))).page;

    // Discovery: the endpoint names its authorization server, which serves its metadata at the root.
    const resource = await json(await worker.fetch("/.well-known/oauth-protected-resource/mcp"));
    assert.match(resource.resource, /\/mcp$/u);
    assert.deepEqual(resource.scopes_supported, ["xmatrix:read", "xmatrix:write"]);
    const serverResponse = await worker.fetch("/.well-known/oauth-authorization-server");
    assert.equal(serverResponse.status, 200, await serverResponse.clone().text());
    const server = await serverResponse.json();
    assert.equal(server.issuer, resource.authorization_servers[0]);
    assert.match(server.registration_endpoint, /\/api\/auth\/oauth2\/register$/u);
    const anonymous = await worker.fetch("/mcp", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get("www-authenticate"), /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/u);
    const asSession = await worker.fetch("/mcp", { method: "POST", headers: auth,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    assert.equal(asSession.status, 401, "an xMatrix session token is not an MCP token");

    // The member is signed in (a Better Auth session) and allows the app.
    await db.query(`INSERT INTO control.auth_users(id,name,email,email_verified,created_at,updated_at)
      VALUES ($1,'Mcp Member','mcp@example.com',true,now(),now()) ON CONFLICT (id) DO NOTHING`, [userId]);
    const session = randomBytes(24).toString("hex");
    await db.query(`INSERT INTO control.auth_sessions(id,expires_at,token,created_at,updated_at,user_id)
      VALUES ($1, now() + interval '1 day', $2, now(), now(), $3)`, [randomUUID(), session, userId]);
    const call = (path, { method = "GET", body, form, signedIn } = {}) => worker.fetch(`/api/auth${path}`, {
      method, headers: { accept: "application/json", origin: APP, ...(signedIn ? { authorization: `Bearer ${session}` } : {}),
        ...(body ? { "content-type": "application/json" } : form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : form ? { body: new URLSearchParams(form).toString() } : {}),
    });
    /** An app is registered and allowed `scope`; returns an MCP caller holding its access token. */
    const connectApp = async (scope) => {
      const client = await json(await call("/oauth2/register", { method: "POST", body: {
        redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "Chat", scope } }));
      const verifier = randomBytes(32).toString("base64url");
      const authorize = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT,
        scope, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256", resource: resource.resource });
      const consent = new URL((await json(await call(`/oauth2/authorize?${authorize}`, { signedIn: true }))).url);
      const back = new URL((await json(await call("/oauth2/consent", { method: "POST", signedIn: true,
        body: { accept: true, oauth_query: consent.search.slice(1) } }))).url);
      const tokens = await json(await call("/oauth2/token", { method: "POST", form: { grant_type: "authorization_code",
        code: back.searchParams.get("code"), code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT } }));
      let id = 0;
      return async (method, params = {}, expectedStatus = 200) => {
        const response = await worker.fetch("/mcp", { method: "POST", headers: {
          authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
        assert.equal(response.status, expectedStatus, await response.clone().text());
        return (await response.json()).result;
      };
    };
    const mcp = await connectApp("xmatrix:read offline_access");
    const tool = async (name, args) => (await mcp("tools/call", { name, arguments: args })).structuredContent;
    assert.equal((await mcp("initialize", { protocolVersion: "2025-06-18" })).serverInfo.name, "xmatrix");
    const tools = (await mcp("tools/list")).tools;
    assert.deepEqual(tools.map((item) => item.name).sort(),
      ["list_channels", "list_pages", "list_spaces", "read_channel", "read_page", "search_pages", "show_page"]);
    assert.ok(tools.every((item) => item.annotations.readOnlyHint === true), "reading is all a read grant offers");
    assert.ok((await tool("list_spaces", {})).spaces.some((item) => item.id === space.id));
    assert.ok((await tool("list_pages", { spaceId: space.id })).pages.some((page) => page.pageId === roadmap.pageId));
    assert.equal((await tool("search_pages", { spaceId: space.id, query: "MCP server" })).results[0].pageId, roadmap.pageId);
    const read = await tool("read_page", { spaceId: space.id, pageId: roadmap.pageId });
    assert.equal(read.body, "# Roadmap\n\nShip the MCP server.\n");
    assert.match(read.url, new RegExp(`pages\\?page=${roadmap.pageId}$`, "u"));
    const show = tools.find((item) => item.name === "show_page");
    const resources = (await mcp("resources/list")).resources;
    assert.ok(resources.some((item) => item.uri === show._meta.ui.resourceUri));
    const card = (await mcp("resources/read", { uri: show._meta.ui.resourceUri })).contents[0];
    assert.equal(card.mimeType, "text/html;profile=mcp-app");
    assert.ok(!card.text.includes("Ship the MCP server."), "the static template has no private page data");
    assert.deepEqual(await tool("show_page", { spaceId: space.id, pageId: roadmap.pageId }), read);
    const elsewhere = await mcp("tools/call", { name: "read_page", arguments: { spaceId: `space-${randomUUID()}`, pageId: roadmap.pageId } });
    assert.equal(elsewhere.isError, true, "a Space the member is not in reads as an error the model sees");
    assert.equal((await mcp("tools/call", { name: "show_page", arguments: {
      spaceId: `space-${randomUUID()}`, pageId: roadmap.pageId } })).isError, true, "page cards use the same access check");
    const noRead = await connectApp("openid");
    assert.equal(await noRead("resources/list", {}, 403), undefined, "no MCP access without a reading grant");
    assert.equal(await noRead("resources/read", { uri: show._meta.ui.resourceUri }, 403), undefined);

    // A write grant adds the writing tools; each acts through the Hub's own routes as the member.
    const writer = await connectApp("xmatrix:read xmatrix:write");
    const write = async (name, args) => (await writer("tools/call", { name, arguments: args }));
    assert.deepEqual((await writer("tools/list")).tools.filter((item) => !item.annotations.readOnlyHint)
      .map((item) => item.name).sort(), ["create_page", "edit_page", "send_message"]);
    const created = (await write("create_page", { spaceId: space.id, title: "Launch notes",
      body: "# Launch notes\n\nDrafted in ChatGPT.\n", parentPageId: roadmap.pageId })).structuredContent;
    const page = await json(await worker.fetch(`${pages}/${encodeURIComponent(created.pageId)}`, { headers: auth }));
    assert.equal(page.page.parentPageId, roadmap.pageId);
    assert.equal(page.page.revisionInfo.authors[0].id, userId, "the member wrote it");
    const edited = (await write("edit_page", { spaceId: space.id, pageId: created.pageId,
      baseRevision: created.revision, body: "# Launch notes\n\nShipped.\n" })).structuredContent;
    assert.equal(edited.revision, created.revision + 1);
    const stale = await write("edit_page", { spaceId: space.id, pageId: created.pageId, baseRevision: created.revision,
      body: "# Launch notes\n\nSomething else entirely.\n" });
    assert.equal(stale.isError, true, "an edit on an old revision that overlaps is refused with the current text");
    assert.match(stale.content[0].text, /Shipped\./u);
    const channel = (await json(await worker.fetch("/api/channels", { method: "POST", headers: auth,
      body: JSON.stringify({ name: `mcp-${randomUUID().slice(0, 8)}`, spaceId: space.id, mode: "open" }) }))).channel;
    const sent = (await write("send_message", { channelId: channel.id, body: "Posted from ChatGPT" })).structuredContent;
    const history = await json(await worker.fetch(`/api/channels/${encodeURIComponent(channel.id)}/history`, { headers: auth }));
    const message = history.messages.find((item) => item.messageId === sent.messageId);
    assert.equal(message.body, "Posted from ChatGPT");
    assert.equal(message.from.userId, userId, "sent as the member");
    assert.equal(await mcp("tools/call", { name: "send_message", arguments: { channelId: channel.id, body: "x" } }),
      undefined, "a read grant has no writing tool to call");
  } finally {
    await db.end();
    await worker.stop();
  }
});
