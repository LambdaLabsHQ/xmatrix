import { withProviderResponses as fetched } from "./support/fetch-responses.mjs";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { GOOGLE_ACTIONS, googleDocumentExcerpt, googleDocumentTarget, verifyGoogle } from "../src/connectors/actions/google.ts";
import { exchangeOAuthGrant, oauthAuthorizeUrl, oauthClient, refreshOAuthFields, verifyOAuthState } from "../src/connectors/oauth.ts";
import { parseActionCommand } from "../src/connectors/action-parse.ts";
import { getAppConnectorProvider } from "../src/app-connectors.ts";
import { ProviderRequestError } from "../src/connectors/http.ts";

const exchangeOAuthCode = async (...args) => (await exchangeOAuthGrant(...args)).fields;

const env = { CONNECTOR_GOOGLE_CLIENT_ID: "fixture-client.apps.googleusercontent.com", CONNECTOR_GOOGLE_CLIENT_SECRET: "fixture-secret" };
const scope = "https://www.googleapis.com/auth/drive.file";
const grant = { access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600, scope };
const id = "fixture_doc_123456";
const paragraph = text => ({ paragraph: { elements: [{ textRun: { content: text } }] } });


test("Google authorization requests only offline drive.file with signed Space/admin state", async () => {
  const client = oauthClient(env, "google");
  const url = new URL(await oauthAuthorizeUrl(client, { spaceId: "space-1", userId: "admin-1", redirectUri: "https://hub.test/cb" }));
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("scope"), scope);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.has("include_granted_scopes"), false);
  const verified = await verifyOAuthState(env, url.searchParams.get("state"));
  assert.equal(verified.spaceId, "space-1");
  assert.equal(verified.userId, "admin-1");
  assert.equal(await verifyOAuthState({ ...env, CONNECTOR_GOOGLE_CLIENT_SECRET: "other-app" }, url.searchParams.get("state")), undefined);
});

test("Google code exchange records a complete per-file grant and rejects broader, missing or malformed grants", async () => {
  const { result, calls } = await fetched([{ body: grant }], () => exchangeOAuthCode(oauthClient(env, "google"), "code", "https://hub.test/cb"));
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(calls[0].headers.get("content-type"), "application/x-www-form-urlencoded");
  assert.deepEqual(calls[0].body, { grant_type: "authorization_code", code: "code", redirect_uri: "https://hub.test/cb",
    client_id: env.CONNECTOR_GOOGLE_CLIENT_ID, client_secret: env.CONNECTOR_GOOGLE_CLIENT_SECRET });
  assert.equal(result.oauthRefreshToken, grant.refresh_token);
  assert.ok(Number(result.oauthExpiresAt) > Date.now());
  for (const changes of [{ scope: undefined }, { scope: "https://www.googleapis.com/auth/drive" },
    { scope: `${scope} https://www.googleapis.com/auth/drive.readonly` }, { refresh_token: undefined },
    { expires_in: 0 }, { expires_in: 1000000 }, { token_type: "other" }, { access_token: undefined }]) {
    await fetched([{ body: { ...grant, ...changes } }], async calls => {
      await assert.rejects(exchangeOAuthCode(oauthClient(env, "google"), "code", "https://hub.test/cb"));
      assert.equal(calls.length, 1);
    });
  }
});

test("Google refresh retains an unrotated refresh token and never accepts a broadened scope", async () => {
  const now = Date.now();
  const credentials = { oauthToken: "old", oauthRefreshToken: "keep", oauthExpiresAt: String(now + 10_000) };
  const { result, calls } = await fetched([{ body: { ...grant, access_token: "new", refresh_token: undefined, scope: undefined } }],
    () => refreshOAuthFields(env, "google", credentials, now));
  assert.equal(result.oauthToken, "new");
  assert.equal("oauthRefreshToken" in result, false);
  assert.equal(result.oauthExpiresAt, String(now + 3600_000));
  assert.equal(calls[0].body.refresh_token, "keep");
  await fetched([{ body: { ...grant, scope: "https://www.googleapis.com/auth/drive" } }], () =>
    assert.rejects(refreshOAuthFields(env, "google", credentials, now), /per-file OAuth grant/));
});

test("document addresses reject external hosts, userinfo and path injection and preserve explicit tabs", () => {
  assert.deepEqual(googleDocumentTarget(`https://docs.google.com/document/d/${id}/edit?tab=t.1`), { document: id, tab: "t.1" });
  assert.deepEqual(googleDocumentTarget(`${id}#tab=t.2`), { document: id, tab: "t.2" });
  for (const target of [`https://docs.google.com.evil.test/document/d/${id}/edit`,
    `https://user@docs.google.com/document/d/${id}/edit`, `http://docs.google.com/document/d/${id}`,
    `https://docs.google.com/document/d/${id}/evil/path`, `${id}?scope=all`, `${id}#tab=../other`, "short"]) {
    assert.equal(googleDocumentTarget(target), undefined, target);
  }
  for (const [action, target, text] of [["create_doc", "old", "title"], ["create_doc", "new", "two\nlines"],
    ["append_doc", id, "a\u0000b"], ["append_doc", id, "x".repeat(4001)], ["read_doc", id, "extra"]]) {
    assert.equal(typeof GOOGLE_ACTIONS[action].parse({ target, text }), "string");
  }
  assert.equal(parseActionCommand("google", `@google:read_doc:${id}`).actionId, "read_doc");
});

test("read includes all tabs, nested tabs and table text, supports one tab and reports limits", async () => {
  const tabs = [{ tabProperties: { title: "Requirements", tabId: "t.1" }, documentTab: { body: { content: [paragraph("first\n"),
    { table: { tableRows: [{ tableCells: [{ content: [paragraph("cell\n")] }] }] } }] } },
    childTabs: [{ tabProperties: { title: "Subtab", tabId: "t.2" }, documentTab: { body: { content: [paragraph("second\n")] } } }] }];
  const { result, calls } = await fetched([{ body: { documentId: id, title: "Plan", tabs } }], () =>
    GOOGLE_ACTIONS.read_doc.execute({ credentials: { oauthToken: "access" } }, { document: id }));
  assert.match(calls[0].url, /includeTabsContent=true$/);
  assert.equal(calls[0].headers.get("authorization"), "Bearer access");
  for (const word of ["first", "cell", "second", "Subtab", "untrusted"]) assert.ok(result.summary.includes(word));
  const excerpt = googleDocumentExcerpt({ tabs }, "t.2");
  assert.match(excerpt.text, /second/);
  assert.doesNotMatch(excerpt.text, /first|cell/);
  assert.throws(() => googleDocumentExcerpt({ tabs }, "missing"), /requested document tab/);
  const long = googleDocumentExcerpt({ body: { content: [paragraph("x".repeat(15000))] } });
  assert.equal(long.text.length, 12000);
  assert.equal(long.truncated, true);
});

test("read fails on denied access and mismatched or malformed document data", async () => {
  for (const response of [{ status: 403 }, { status: 404 }, { body: { documentId: "other", title: "wrong" } },
    { body: { documentId: id, title: "bad", tabs: [{}] } }]) {
    await fetched([response], async calls => {
      await assert.rejects(GOOGLE_ACTIONS.read_doc.execute({ credentials: { oauthToken: "access" } }, { document: id }));
      assert.equal(calls.length, 1);
    });
  }
});

test("create and append are separate policy-declared writes, use fixed origins and never replay failed mutations", async () => {
  const manifest = getAppConnectorProvider("google");
  assert.equal(manifest.actions.find(action => action.id === "create_doc").effect, "write");
  assert.equal(manifest.actions.find(action => action.id === "append_doc").effect, "write");
  assert.ok(manifest.actions.some(action => action.id === "policy"));
  const created = await fetched([{ body: { documentId: id } }], () =>
    GOOGLE_ACTIONS.create_doc.execute({ credentials: { oauthToken: "access" } }, { title: "Work plan" }));
  assert.deepEqual(created.calls[0].body, { title: "Work plan" });
  assert.equal(created.calls.length, 1);
  assert.equal(created.result.url, `https://docs.google.com/document/d/${id}/edit`);
  const appended = await fetched([{ body: { documentId: id, replies: [{}] } }], () =>
    GOOGLE_ACTIONS.append_doc.execute({ credentials: { oauthToken: "access" } }, { document: id, tab: "t.2", text: "Done\n" }));
  assert.deepEqual(appended.calls[0].body, { requests: [{ insertText: { endOfSegmentLocation: { tabId: "t.2" }, text: "Done\n" } }] });
  for (const response of [{ status: 403 }, { status: 429 }, { error: new DOMException("timeout", "TimeoutError") }, { body: {} }]) {
    await fetched([response], async calls => {
      await assert.rejects(GOOGLE_ACTIONS.append_doc.execute({ credentials: { oauthToken: "access" } }, { document: id, text: "Once" }));
      assert.equal(calls.length, 1, "ambiguous write is not retried");
    });
  }
});

test("file listing is bounded, does not follow provider links, and fails on malformed lists", async () => {
  const { result, calls } = await fetched([{ body: { files: [{ id, name: "Plan", mimeType: "application/vnd.google-apps.document",
    webViewLink: "https://evil.test/redirect" }], nextPageToken: "more" } }], () =>
    GOOGLE_ACTIONS.list_files.execute({ credentials: { oauthToken: "access" } }, {}));
  assert.equal(new URL(calls[0].url).searchParams.get("pageSize"), "20");
  assert.equal(new URL(calls[0].url).searchParams.get("q"), "trashed = false");
  assert.match(result.summary, /more available/);
  assert.doesNotMatch(result.summary, /evil/);
  await fetched([{ body: {} }], () => assert.rejects(GOOGLE_ACTIONS.list_files.execute({ credentials: { oauthToken: "access" } }, {})));
});

test("Google Check confirms a real minimal Drive identity without writing or accepting missing tokens", async () => {
  const { calls } = await fetched([{ body: { user: { permissionId: "identity" } } }], () => verifyGoogle({ oauthToken: "access" }));
  assert.equal(calls[0].url, "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)");
  assert.equal(calls[0].method, "GET");
  for (const response of [{ status: 401 }, { body: {} }, { body: { user: { permissionId: 123 } } }]) {
    await fetched([response], () => assert.rejects(verifyGoogle({ oauthToken: "access" })));
  }
  await fetched([], async calls => {
    await assert.rejects(verifyGoogle({}), /Connect Google/);
    assert.equal(calls.length, 0);
  });
});

test("a failed Google refresh stops before writes; a refreshed grant uses current-version CAS", async () => {
  const load = await compileCommonJsSourceModule(new URL("../src/connectors/connection-credentials.ts", import.meta.url));
  const credentials = { oauthToken: "old", oauthRefreshToken: "refresh", oauthExpiresAt: String(Date.now() - 1000) };
  for (const [response, rejectCAS] of [[{ status: 401 }, false], [{ body: grant }, true], [{ body: grant }, false]]) {
    const puts = [];
    const dependencies = {
      "../app-connectors": { getAppConnectorProvider },
      "./credentials": { connectorCredentialRepository: () => ({ resolve: async () => ({ values: credentials, version: 7 }),
        put: async input => { puts.push(input); if (rejectCAS) throw new Error("credentials changed"); } }) },
      "./actions/notion": { verifyNotion: () => assert.fail("Google must not call Notion") },
      "./http": { ProviderRequestError }, "./oauth": { refreshOAuthFields },
    };
    const exports = load(name => dependencies[name], { crypto, Date, Object });
    await fetched([response, { body: { documentId: id, replies: [{}] } }], async calls => {
      const operation = async () => {
        const current = await exports.connectionCredentials(env, "space-google", "google");
        await GOOGLE_ACTIONS.append_doc.execute({ credentials: current }, { document: id, text: "Once" });
      };
      if (response.status === 401 || rejectCAS) {
        await assert.rejects(operation());
        assert.equal(calls.length, 1);
      } else {
        await operation();
        assert.equal(calls[1].headers.get("authorization"), `Bearer ${grant.access_token}`);
        assert.equal(puts[0].expectedVersion, 7);
        assert.equal(puts[0].asHub, true);
      }
    });
  }
});
