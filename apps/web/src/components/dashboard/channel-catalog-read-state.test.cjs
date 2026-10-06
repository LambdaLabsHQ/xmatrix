const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const compiledPaths = [];

function compile(name, rewrites = {}) {
  const compiledPath = path.join(__dirname, `.${name}-${process.pid}.cjs`);
  const compiled = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, `${name}.ts`), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    },
  );
  const text = Object.entries(rewrites).reduce(
    (current, [from, to]) => current.split(from).join(to),
    compiled.outputText,
  );
  fs.writeFileSync(compiledPath, text);
  compiledPaths.push(compiledPath);
  return compiledPath;
}

const readStatePath = compile("channel-read-state");
const { applyChannelReadStateToCatalog } = require(compile("channel-catalog-read-state", {
  '"./channel-read-state"': JSON.stringify(readStatePath),
}));

test.after(() => {
  for (const compiledPath of compiledPaths) fs.rmSync(compiledPath, { force: true });
});

const PREFIX = ["xmatrix", "https://hub.test", "user-1"];

function catalogKey(filter) {
  return [...PREFIX, "channels", "space-1", "catalog", "flat", filter, null, ""];
}

function attention(count) {
  return {
    channelId: "channel-1",
    unreadAttentionCount: count,
    updatedAt: "2026-09-18T06:00:00.000Z",
  };
}

function page(rows, counts) {
  return {
    protocolVersion: 1,
    catalogRevision: 3,
    rows,
    nextCursor: null,
    counts: counts ?? null,
  };
}

function row(channel) {
  return { channel, ownActivityAt: "2026-09-18T06:00:00.000Z", hasChildren: false };
}

function fakeClient(entries) {
  const store = entries.map(([queryKey, data]) => ({ queryKey, data }));
  return {
    store,
    data(queryKey) {
      return store.find((entry) => entry.queryKey === queryKey).data;
    },
    getQueryCache: () => ({
      findAll: ({ queryKey: prefix }) => store.filter((entry) => (
        prefix.every((part, index) => entry.queryKey[index] === part)
      )),
    }),
    setQueryData(queryKey, updater) {
      const entry = store.find((item) => item.queryKey === queryKey);
      entry.data = updater(entry.data);
    },
  };
}

test("a read acknowledgement clears the cached catalog row the sidebar renders", () => {
  const key = catalogKey("all");
  const client = fakeClient([[key, {
    pages: [page(
      [
        row({ id: "channel-1", messageCount: 12, readSequence: 4, attention: attention(2) }),
        row({ id: "channel-2", messageCount: 3, readSequence: 1 }),
      ],
      { active: 2, archive: 0, unread: 2, mentions: 1 },
    )],
  }]]);

  applyChannelReadStateToCatalog({
    client,
    prefix: PREFIX,
    readStates: new Map([["channel-1", { readSequence: 12, attention: undefined }]]),
  });

  const [first, second] = client.data(key).pages[0].rows;
  assert.equal(first.channel.readSequence, 12);
  assert.equal(first.channel.attention, undefined);
  assert.equal(first.hasChildren, false, "the row keeps its catalog shape");
  assert.equal(second.channel.readSequence, 1, "an unrelated row is untouched");
  assert.deepEqual(client.data(key).pages[0].counts, {
    active: 2, archive: 0, unread: 1, mentions: 0,
  });
});

test("a cached row that is already further ahead keeps its cursor", () => {
  const key = catalogKey("all");
  const client = fakeClient([[key, {
    pages: [page([row({ id: "channel-1", messageCount: 20, readSequence: 18 })])],
  }]]);

  applyChannelReadStateToCatalog({
    client,
    prefix: PREFIX,
    readStates: new Map([["channel-1", { readSequence: 9, attention: undefined }]]),
  });

  assert.equal(client.data(key).pages[0].rows[0].channel.readSequence, 18);
});

test("an answer without a cursor leaves the row's cursor absent", () => {
  const key = catalogKey("all");
  const client = fakeClient([[key, {
    pages: [page([row({ id: "channel-1", messageCount: 5, attention: attention(1) })])],
  }]]);

  applyChannelReadStateToCatalog({
    client,
    prefix: PREFIX,
    readStates: new Map([["channel-1", { readSequence: undefined, attention: undefined }]]),
  });

  const { channel } = client.data(key).pages[0].rows[0];
  assert.equal("readSequence" in channel, false, "a zero would claim nothing was read");
  assert.equal(channel.attention, undefined);
});

test("only catalog pages are rewritten", () => {
  const counts = [...PREFIX, "channels", "space-1", "catalog-counts"];
  const resolve = [...PREFIX, "channels", "space-1", "resolve", false, [], null];
  const untouched = { pages: [page([row({ id: "channel-1", messageCount: 4 })])] };
  const client = fakeClient([[counts, untouched], [resolve, untouched]]);

  applyChannelReadStateToCatalog({
    client,
    prefix: PREFIX,
    readStates: new Map([["channel-1", { readSequence: 4, attention: undefined }]]),
  });

  assert.equal(client.data(counts), untouched);
  assert.equal(client.data(resolve), untouched);
});
