import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import { APP_CONNECTOR_PROVIDER_MANIFESTS } from "../../protocol/src/app-connector-manifests.ts";
import { parseActionCommand, parsePolicyCommand } from "../src/connectors/action-parse.ts";
import { actionRefusal, connectorCommands, isPolicyAction } from "../src/connectors/connector-commands.ts";
import { providerUrl } from "../src/connectors/http.ts";
import { connectorForCommand, connectorProvider } from "../src/connectors/registry.ts";

function stubFetch(responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: new Headers(init.headers),
      body: init.body ? JSON.parse(init.body) : undefined });
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function run(providerId, body, credentials, responses = []) {
  const provider = connectorProvider(providerId);
  const parsed = parseActionCommand(providerId, body);
  assert.ok(parsed, `${body} parses`);
  const action = provider.actions[parsed.actionId];
  const input = action.parse(parsed.statement);
  assert.equal(typeof input, "object", typeof input === "string" ? input : "");
  const fetch = stubFetch(responses);
  try {
    return { result: await action.execute({ credentials }, input), calls: fetch.calls };
  } finally {
    fetch.restore();
  }
}

test("every manifest write action has an executor that declares it, and every executor is in the manifest", () => {
  for (const manifest of APP_CONNECTOR_PROVIDER_MANIFESTS.filter((candidate) => candidate.id !== "github")) {
    const provider = connectorProvider(manifest.id);
    const declared = manifest.actions.filter((action) => action.effect).map((action) => action.id).sort();
    assert.deepEqual(Object.keys(provider.actions ?? {}).sort(), declared, manifest.id);
    for (const id of declared) {
      assert.equal(provider.actions[id].effect, manifest.actions.find((action) => action.id === id).effect);
      for (const field of provider.actions[id].requires.flatMap((entry) => entry.split("|"))) {
        assert.ok(manifest.credentials.some((credential) => credential.id === field), `${manifest.id}.${id} needs ${field}`);
      }
    }
    if (declared.length > 0) assert.ok(manifest.actions.some((action) => action.id === "policy"), `${manifest.id} policy`);
  }
});

test("action commands take one statement whose text spans the following lines", () => {
  assert.deepEqual(parseActionCommand("linear", "@linear:create_issue:ENG Fix login\nSteps:\n1. open"), {
    actionId: "create_issue", statement: { target: "ENG", text: "Fix login\nSteps:\n1. open" } });
  assert.equal(parseActionCommand("linear", "please @linear:comment:ENG-1 hi"), undefined);
  assert.equal(connectorForCommand("@slack:post:C0123456789 hello")?.id, "slack");
  assert.equal(connectorForCommand("@slack:policy:post allow")?.id, "slack");
  assert.equal(connectorForCommand("@slack:nope:C1 hi"), undefined, "an unknown action is not a command");
  assert.equal(connectorForCommand("@circleci:post:x hi"), undefined, "an event-only provider takes no actions");
  assert.deepEqual(parsePolicyCommand({ target: "post", text: "allow" }), { actionId: "post", mode: "allow" });
  assert.deepEqual(parsePolicyCommand({ target: "post", text: "default" }), { actionId: "post", mode: null });
  assert.ok("error" in parsePolicyCommand({ target: "post", text: "maybe" }));
});

test("policy: every action runs for a Human or an Agent until the Channel denies it", () => {
  for (const provider of APP_CONNECTOR_PROVIDER_MANIFESTS) {
    for (const action of provider.actions.filter((candidate) => candidate.effect)) {
      assert.equal("defaultPolicy" in action, false, `${provider.id}:${action.id} carries its own default`);
      assert.equal(actionRefusal({ actionId: action.id, mode: null }), undefined, `${provider.id}:${action.id}`);
      assert.equal(actionRefusal({ actionId: action.id, mode: "allow" }), undefined, `${provider.id}:${action.id}`);
      assert.match(actionRefusal({ actionId: action.id, mode: "deny" }), /denied/u, `${provider.id}:${action.id}`);
    }
  }
});

test("a Channel policy names only the actions that act on the provider", () => {
  const github = APP_CONNECTOR_PROVIDER_MANIFESTS.find((provider) => provider.id === "github");
  assert.equal(isPolicyAction(github, "merge"), true);
  // A subscription brings the repository's content into the Channel; unsubscribing only narrows it.
  assert.equal(isPolicyAction(github, "subscribe"), true);
  assert.equal(isPolicyAction(github, "unsubscribe"), false);
  assert.equal(isPolicyAction(github, "nope"), false);
});

test("every connector action reads the Channel's policy through channelActionRefusal", () => {
  const src = new URL("../src/", import.meta.url);
  const files = (dir) => readdirSync(dir).flatMap((name) => {
    const url = new URL(name, dir);
    return statSync(url).isDirectory() ? files(new URL(`${name}/`, dir)) : name.endsWith(".ts") ? [url] : [];
  });
  const owner = new URL("connectors/connector-commands.ts", src).href;
  for (const url of files(src)) {
    if (url.href === owner) continue;
    const source = readFileSync(url, "utf8");
    assert.doesNotMatch(source, /\bactionRefusal\(/u, `${url.pathname} decides a Channel policy refusal by hand`);
    assert.doesNotMatch(source, /connectorActionPolicyRepository\([^)]*\)\.mode\(/u,
      `${url.pathname} reads a Channel's action policy mode by hand`);
    assert.doesNotMatch(source, /action\.id === \w+ && action\.effect/u, `${url.pathname} checks a policy action by hand`);
  }
});

test("action targets and text are validated before any provider call", () => {
  const invalid = [
    ["slack", "@slack:post:not-a-channel hi"],
    ["slack", "@slack:post:C0123456789"],
    ["linear", "@linear:comment:ENG hi"],
    ["gitlab", "@gitlab:merge:group/project#5"],
    ["jira", "@jira:transition:ENG-9"],
    ["vercel", "@vercel:redeploy:abc"],
    ["notion", "@notion:append:not-a-page text"],
    ["discord", "@discord:post:abc hi"],
  ];
  for (const [providerId, body] of invalid) {
    const parsed = parseActionCommand(providerId, body);
    assert.equal(typeof connectorProvider(providerId).actions[parsed.actionId].parse(parsed.statement), "string", body);
  }
});

test("Slack post sends the bot token and fails on ok:false", async () => {
  const { result, calls } = await run("slack", "@slack:post:c0123456789/1700000000.000100 Deploy done",
    { botToken: "xoxb-1" }, [{ body: { ok: true, ts: "1.2" } }]);
  assert.equal(calls[0].url, "https://slack.com/api/chat.postMessage");
  assert.equal(calls[0].headers.get("authorization"), "Bearer xoxb-1");
  assert.deepEqual(calls[0].body, { channel: "C0123456789", text: "Deploy done", thread_ts: "1700000000.000100" });
  assert.match(result.summary, /thread/u);
  await assert.rejects(run("slack", "@slack:post:C0123456789 hi", { botToken: "x" }, [{ body: { ok: false, error: "not_in_channel" } }]),
    /not_in_channel/u);
});

test("Linear create_issue resolves the team, then creates the issue with title and description", async () => {
  const { result, calls } = await run("linear", "@linear:create_issue:eng Fix login\nIt fails", { apiKey: "lin_1" }, [
    { body: { data: { teams: { nodes: [{ id: "team-1" }] } } } },
    { body: { data: { issueCreate: { success: true, issue: { identifier: "ENG-7", url: "https://linear.app/i/ENG-7" } } } } },
  ]);
  assert.equal(calls[0].headers.get("authorization"), "lin_1");
  assert.deepEqual(calls[0].body.variables, { key: "ENG" });
  assert.deepEqual(calls[1].body.variables, { teamId: "team-1", title: "Fix login", description: "It fails" });
  assert.deepEqual(result, { summary: "Created ENG-7: Fix login", url: "https://linear.app/i/ENG-7" });
  await assert.rejects(run("linear", "@linear:comment:ENG-1 hi", { apiKey: "k" }, [{ body: { errors: [{ message: "no access" }] } }]),
    /no access/u);
});

test("Sentry resolve maps a short id to its group before updating it", async () => {
  const { calls } = await run("sentry", "@sentry:resolve:web-1a", { authToken: "t", organization: "acme" }, [
    { body: { groupId: "123" } }, { body: {} }]);
  assert.equal(calls[0].url, "https://sentry.io/api/0/organizations/acme/shortids/WEB-1A/");
  assert.equal(calls[1].url, "https://sentry.io/api/0/organizations/acme/issues/123/");
  assert.deepEqual(calls[1].body, { status: "resolved" });
});

test("PagerDuty, GitLab, Jira, Vercel, Discord, Feishu and Notion call their documented endpoints", async () => {
  const pd = await run("pagerduty", "@pagerduty:acknowledge:q1abc", { apiKey: "k", fromEmail: "a@b.c" });
  assert.equal(pd.calls[0].url, "https://api.pagerduty.com/incidents/Q1ABC");
  assert.equal(pd.calls[0].headers.get("from"), "a@b.c");
  assert.deepEqual(pd.calls[0].body, { incident: { type: "incident_reference", status: "acknowledged" } });

  const gl = await run("gitlab", "@gitlab:comment:group/app!5 LGTM", { accessToken: "glpat" });
  assert.equal(gl.calls[0].url, "https://gitlab.com/api/v4/projects/group%2Fapp/merge_requests/5/notes");
  assert.equal(gl.calls[0].headers.get("private-token"), "glpat");

  const jira = await run("jira", "@jira:transition:eng-9 Done", { siteUrl: "https://acme.atlassian.net", email: "a@b.c", apiToken: "t" }, [
    { body: { transitions: [{ id: "31", name: "Done" }] } }, { body: {} }]);
  assert.equal(jira.calls[1].url, "https://acme.atlassian.net/rest/api/3/issue/ENG-9/transitions");
  assert.deepEqual(jira.calls[1].body, { transition: { id: "31" } });
  assert.equal(jira.calls[0].headers.get("authorization"), `Basic ${btoa("a@b.c:t")}`);

  const vercel = await run("vercel", "@vercel:redeploy:dpl_abcdefgh123", { accessToken: "v", teamId: "team_1" }, [
    { body: { name: "web", target: "production" } }, { body: { url: "web-2.vercel.app" } }]);
  assert.equal(vercel.calls[1].url, "https://api.vercel.com/v13/deployments?teamId=team_1");
  assert.deepEqual(vercel.calls[1].body, { name: "web", deploymentId: "dpl_abcdefgh123", target: "production" });
  assert.equal(vercel.result.url, "https://web-2.vercel.app");

  const discord = await run("discord", "@discord:post:123456789012345678 @everyone hi", { botToken: "d" });
  assert.deepEqual(discord.calls[0].body.allowed_mentions, { parse: [] }, "a posted mention never pings");

  const feishu = await run("feishu", "@feishu:send:oc_abcdef hi", { appId: "cli_1", appSecret: "s" }, [
    { body: { code: 0, tenant_access_token: "tt" } }, { body: { code: 0 } }]);
  assert.equal(feishu.calls[1].headers.get("authorization"), "Bearer tt");
  assert.deepEqual(feishu.calls[1].body, { receive_id: "oc_abcdef", msg_type: "text", content: JSON.stringify({ text: "hi" }) });

  const notion = await run("notion", "@notion:append:0123456789abcdef0123456789abcdef First\n\nSecond", { integrationToken: "n" });
  assert.equal(notion.calls[0].url, "https://api.notion.com/v1/blocks/01234567-89ab-cdef-0123-456789abcdef/children");
  assert.equal(notion.calls[0].body.children.length, 2);
});

test("Notion is checked with its bot user, so a token Notion refuses never makes a connection", async () => {
  const verify = connectorProvider("notion").verify;
  const accepted = stubFetch([{ body: { object: "user", type: "bot" } }]);
  try {
    await verify({ integrationToken: "secret_ok" });
    assert.equal(accepted.calls[0].url, "https://api.notion.com/v1/users/me");
    assert.equal(accepted.calls[0].method, "GET");
    assert.equal(accepted.calls[0].headers.get("authorization"), "Bearer secret_ok");
  } finally { accepted.restore(); }
  const refused = stubFetch([{ status: 401, body: { message: "API token is invalid." } }]);
  try {
    await assert.rejects(verify({ integrationToken: "secret_bad" }), /401: API token is invalid/u);
  } finally { refused.restore(); }
});

test("a configured provider URL must be a public https host", () => {
  assert.equal(providerUrl("https://gitlab.example.com", "api/v4/x").toString(), "https://gitlab.example.com/api/v4/x");
  for (const base of ["http://gitlab.example.com", "https://127.0.0.1", "https://[::1]", "https://localhost",
    "https://metadata.internal", "https://intranet"]) {
    assert.throws(() => providerUrl(base, "x"), /public https/u, base);
  }
});

test("a provider's command handler accepts its subscriptions, actions and policy, and nothing else", () => {
  const handler = connectorCommands("slack", connectorProvider("slack").actions);
  assert.ok(handler.accepts("@slack:subscribe:C0123456789"));
  assert.ok(handler.accepts("@slack:post:C0123456789 hi"));
  assert.ok(handler.accepts("@slack:policy:post allow"));
  assert.ok(!handler.accepts("@slack:delete:C0123456789"));
  assert.ok(!handler.accepts("@linear:comment:ENG-1 hi"));
});

test("connector MCP lists the connected providers' actions and runs a call as the Agent in its Run's Channel", async () => {
  const { handleConnectorMcp } = await import("../src/connectors/mcp.ts");
  const caller = { ownerUserId: "owner", channelId: "channel-1", runId: "run-1", spaceId: "space-1" };
  const initialized = await (await handleConnectorMcp({}, caller, { jsonrpc: "2.0", id: 1, method: "initialize" })).json();
  assert.equal(initialized.result.serverInfo.name, "xmatrix-connectors");
  const seen = [];
  const connected = async (_env, who) => { seen.push(who); return new Set(["slack", "linear"]); };
  const listed = await (await handleConnectorMcp({}, caller, { jsonrpc: "2.0", id: 2, method: "tools/list" }, undefined,
    connected)).json();
  const names = listed.result.tools.map((tool) => tool.name);
  assert.equal(seen[0].spaceId, "space-1");
  assert.ok(names.includes("slack__post"));
  assert.ok(names.includes("linear__create_issue"));
  assert.ok(!names.some((name) => name.startsWith("notion__") || name.startsWith("openconnector__")),
    "a provider the Space has not connected offers no tools");
  assert.ok(!names.some((name) => name.endsWith("__policy") || name.endsWith("__subscribe")), "only provider actions are tools");
  const unavailable = await (await handleConnectorMcp({}, caller, { jsonrpc: "2.0", id: 5, method: "tools/list" }, undefined,
    async () => { throw new Error("connector connections are unavailable (503)"); })).json();
  assert.equal(unavailable.error.code, -32603);

  const calls = [];
  const run = async (providerId, input, actionId, _action, statement) => {
    calls.push({ providerId, input, actionId, statement });
    return "Slack post: blocked; post is denied in this channel.";
  };
  const called = await (await handleConnectorMcp({}, caller, { jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "slack__post", arguments: { target: "C0123456789", text: "hi" } } }, run)).json();
  assert.equal(called.result.isError, true);
  assert.equal(calls[0].input.senderKind, "agent");
  assert.equal(calls[0].input.channelId, "channel-1");
  assert.equal(calls[0].input.actorUserId, "owner");
  assert.deepEqual(calls[0].statement, { target: "C0123456789", text: "hi" });
  const unknown = await (await handleConnectorMcp({}, caller, { jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "slack__delete", arguments: {} } }, run)).json();
  assert.equal(unknown.error.code, -32602);
  assert.equal((await handleConnectorMcp({}, caller, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
});

test("connector MCP tools carry no policy precondition", async () => {
  const { handleConnectorMcp } = await import("../src/connectors/mcp.ts");
  const caller = { ownerUserId: "owner", channelId: "channel-1", runId: "run-1", spaceId: "space-1" };
  const listed = await (await handleConnectorMcp({}, caller, { jsonrpc: "2.0", id: 1, method: "tools/list" }, undefined,
    async () => new Set(["sentry"]))).json();
  const resolve = listed.result.tools.find((tool) => tool.name === "sentry__resolve");
  assert.ok(resolve, "Sentry resolve is offered");
  assert.doesNotMatch(resolve.description, /policy/u);
  const read = listed.result.tools.find((tool) => tool.name === "sentry__read_issue");
  assert.ok(read && !read.description.includes("policy"), "a read action still needs no policy");
});

test("chat webhook actions only post to their provider's own hosts", async () => {
  const teams = await run("teams", "@teams:post Deploy finished", { webhookUrl: "https://acme.webhook.office.com/webhookb2/x" });
  assert.equal(teams.calls[0].body.attachments[0].content.body[0].text, "Deploy finished");
  await assert.rejects(run("teams", "@teams:post hi", { webhookUrl: "https://evil.example.com/hook" }), /own host/u);
  await assert.rejects(run("googlechat", "@googlechat:post hi", { webhookUrl: "https://chat.googleapis.com.evil.io/v1" }), /own host/u);
  const dingtalk = await run("dingtalk", "@dingtalk:post hi", { accessToken: "at", signSecret: "SEC" }, [{ body: { errcode: 0 } }]);
  const url = new URL(dingtalk.calls[0].url);
  assert.equal(url.hostname, "oapi.dingtalk.com");
  assert.ok(url.searchParams.get("sign") && url.searchParams.get("timestamp"));
  const wecom = await run("wecom", "@wecom:post hello there", { webhookKey: "k" }, [{ body: { errcode: 0 } }]);
  assert.deepEqual(wecom.calls[0].body, { msgtype: "text", text: { content: "hello there" } });
  const telegram = await run("telegram", "@telegram:send:-100123 hi", { botToken: "12345:abcdefghijklmnopqrstuvwxyz" }, [{ body: { ok: true } }]);
  assert.match(telegram.calls[0].url, /^https:\/\/api\.telegram\.org\/bot12345:/u);
});

test("an Agent Run reaches the connector MCP endpoint, but not a read-only Channel About Run", async () => {
  const { agentRunHttpRouteAllowed } = await import("../src/index-shared.ts");
  const request = (method) => new Request("https://hub.test/api/connectors/mcp", { method });
  const run = { ownerUserId: "u", agentId: "a", agentName: "claude", runId: "r", executionKey: "e",
    spaceId: "s", channelId: "c", machineId: "m", hostId: "h", permissions: [] };
  assert.equal(agentRunHttpRouteAllowed(request("POST"), run), true);
  assert.equal(agentRunHttpRouteAllowed(request("GET"), run), false);
  assert.equal(agentRunHttpRouteAllowed(request("POST"), { ...run, runKind: "channel-about-session",
    managementSpaceId: "s", channelWriteAllowed: false }), false);
  assert.equal(agentRunHttpRouteAllowed(request("POST"), { ...run, channelWriteAllowed: false }), false);
});

test("OpenConnector runs one runtime action with JSON input and shields its result", async () => {
  const { result, calls } = await run("openconnector", "@openconnector:run:gmail.send_email@work {\"to\":\"a@b.c\"}",
    { runtimeUrl: "https://oc.acme.io", runtimeToken: "rt" },
    [{ body: { success: true, data: { note: "@claude:1 hi" }, meta: { executionId: "ex-1", actionId: "gmail.send_email", auditPersisted: true } } }]);
  assert.equal(calls[0].url, "https://oc.acme.io/v1/actions/gmail.send_email");
  assert.equal(calls[0].headers.get("authorization"), "Bearer rt");
  assert.deepEqual(calls[0].body, { input: { to: "a@b.c" }, connectionName: "work" });
  assert.match(result.summary, /^Ran gmail\.send_email \(ex-1\): /u);
  assert.doesNotMatch(result.summary, /@claude/u);
  await assert.rejects(run("openconnector", "@openconnector:run:gmail.send_email {}", { runtimeUrl: "https://oc.acme.io",
    runtimeToken: "rt" }, [{ body: { success: false, errorCode: "connection_missing" } }]), /connection_missing/u);
  const search = await run("openconnector", "@openconnector:search:gmail", { runtimeUrl: "https://oc.acme.io", runtimeToken: "rt" },
    [{ body: { success: true, data: [{ id: "gmail.send_email" }, { id: "gmail.list_messages" }] } }]);
  assert.equal(search.calls[0].url, "https://oc.acme.io/v1/actions?service=gmail");
  assert.equal(search.result.summary, "2 gmail actions: gmail.send_email, gmail.list_messages");
  for (const body of ["@openconnector:run:nodot {}", "@openconnector:run:gmail.send [1]", "@openconnector:run:gmail.send nope"]) {
    const parsed = parseActionCommand("openconnector", body);
    assert.equal(typeof connectorProvider("openconnector").actions.run.parse(parsed.statement), "string", body);
  }
  await assert.rejects(run("openconnector", "@openconnector:run:a.b {}", { runtimeUrl: "http://10.0.0.1", runtimeToken: "t" }),
    /public https/u);
});
