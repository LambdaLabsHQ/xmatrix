import assert from "node:assert/strict";
import test from "node:test";
import { createSpace, json, randomUUID } from "./agent-launch-postgres.fixture.mjs";
import { connectGitHubInstallation, inWorkerTransaction } from "./registration-launch.fixture.mjs";
import { withGitHubUserScenario } from "./support/github-user-worker.mjs";

test("a page reads only its referenced file, with current access even after a cached read", async () => {
  const userId = `github-file-${randomUUID()}`;
  const installationId = "file-installation";
  const reference = "xmatrix:github-file/acme/widgets/docs/prompt.md";
  const text = "# Private prompt\n\nRepository content.\n";
  await withGitHubUserScenario({ id: userId, email: "github-file@example.com", name: "File Reader" }, {
    installationId, repository: "acme/widgets", permissions: { contents: "read", metadata: "read" },
    routes: { "/repos/acme/widgets/contents/docs/prompt.md": { type: "file", encoding: "base64",
      content: Buffer.from(text).toString("base64"), size: Buffer.byteLength(text), sha: "abc123",
      html_url: "https://github.com/acme/widgets/blob/main/docs/prompt.md" } },
  }, undefined, async ({ worker, auth }) => {
    const space = await createSpace(worker, `File embeds ${randomUUID()}`);
    const pages = `/api/spaces/${encodeURIComponent(space.id)}/pages`;
    const page = (await json(await worker.fetch(pages, { method: "POST", headers: auth,
      body: JSON.stringify({ title: "Prompts", body: `[prompt.md](${reference})\n` }) }))).page;
    const url = `${pages}/${encodeURIComponent(page.pageId)}`;
    const read = (href = reference, headers = auth) => worker.fetch(`${url}/github-file?href=${encodeURIComponent(href)}`,
      { headers });
    const refusal = async (response, status, code) => {
      assert.equal(response.status, status, await response.clone().text());
      assert.equal((await response.json()).code, code);
    };

    await refusal(await read(), 409, "github_connection_required");
    await refusal(await read("xmatrix:github-file/acme/widgets/docs/other.md"), 404, "page_github_file_not_referenced");
    await refusal(await read("https://github.com/acme/widgets"), 400, "invalid_request");
    assert.equal((await read(reference, {})).status, 401, "anonymous readers cannot fetch private file content");
    await connectGitHubInstallation(worker, { spaceId: space.id, userId, installationId });
    const response = await read();
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).text, text);
    assert.equal((await json(await read())).text, text, "a second authorized read can use the cache");

    await json(await worker.fetch(`${url}/publication`, { method: "PUT", headers: auth,
      body: JSON.stringify({ published: true }) }));
    const publicUrl = `/api/public/spaces/${encodeURIComponent(space.id)}/pages/${encodeURIComponent(page.pageId)}`;
    const published = await json(await worker.fetch(publicUrl));
    assert.equal(published.page.body, `[prompt.md](${reference})\n`, "publication contains only the reference");
    assert.equal((await worker.fetch(`${publicUrl}/github-file?href=${encodeURIComponent(reference)}`)).status, 404,
      "there is no public file-content endpoint");

    await inWorkerTransaction(worker, tx => tx.query({ text: `UPDATE data.app_connector_connections
      SET metadata_json=$2::jsonb, version=version+1 WHERE connection_id=$1`,
      values: [`${space.id}:github`, JSON.stringify({ installationIds: ["another-installation"] })] }));
    await refusal(await read(), 403, "github_repository_not_covered");

    const current = (await json(await worker.fetch(url, { headers: auth }))).page;
    await json(await worker.fetch(url, { method: "PUT", headers: auth,
      body: JSON.stringify({ baseRevision: current.headRevision, body: "No file is embedded.\n" }) }));
    await refusal(await read(), 404, "page_github_file_not_referenced");
  });
});
