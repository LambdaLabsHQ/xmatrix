import assert from "node:assert/strict";
import { sourceText } from "./source-file.fixture.mjs";
import { test } from "node:test";

/* Each ingress once checked a subscription's liveness its own way: GitHub
   skipped deleted Spaces' checks, generic connectors skipped the subscriber's
   access, and the GitHub webhook re-read every connection to check it again. */
test("every route read tests a subscription's liveness through the one fragment", () => {
  const text = sourceText("app-control.ts");
  const queries = text.split("tx.query").slice(1)
    .filter((query) => /FROM data\.app_source_relations r JOIN data\.app_connector_connections c/u.test(query));
  const routes = queries.filter((query) => !/app_github_subscribed_sources_v/u.test(query.slice(0, 200)));
  assert.ok(routes.length >= 2, "the GitHub and connector route reads are found");
  for (const query of routes) {
    assert.match(query.slice(0, 2_000), /\$\{LIVE_SOURCE_RELATION_SQL\}/u,
      `route read ${/name: "([^"]+)"/u.exec(query)?.[1]} tests liveness through LIVE_SOURCE_RELATION_SQL`);
  }
  assert.equal(text.match(/c\.status='configured'\n\s+AND NOT EXISTS \(SELECT 1 FROM data\.space_deletions/gu)?.length, 1);
});
