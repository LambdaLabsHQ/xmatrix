import { createServer } from "node:http";

/**
 * GitHub's REST API as the Hub uses it through a Space's installation: the
 * repository's installation, an installation token with the given
 * permissions, the installation's repositories, and whatever GET routes a test
 * answers. Check runs the Hub publishes are recorded in `checkRuns`.
 */
export function fakeGitHubApi({ installationId, repository, permissions, routes = {} }) {
  const checkRuns = [];
  const [owner, name] = repository.split("/");
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      const url = request.url ?? "";
      const reply = (status, body) => { response.statusCode = status; response.end(JSON.stringify(body)); };
      if (url === `/repos/${repository}/installation`) return reply(200, { id: installationId });
      if (url.includes(`/app/installations/${installationId}/access_tokens`)) {
        return reply(200, { token: "ghs_fixture", expires_at: "2099-01-01T00:00:00Z", permissions });
      }
      if (url.startsWith("/installation/repositories")) {
        return reply(200, { total_count: 1, repositories: [{ id: 1, name, full_name: repository, private: false,
          archived: false, owner: { login: owner } }] });
      }
      if (request.method === "POST" && url === `/repos/${repository}/check-runs`) {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => { checkRuns.push(JSON.parse(body)); reply(201, {}); });
        return undefined;
      }
      return url in routes ? reply(200, routes[url]) : reply(404, {});
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, checkRuns, close: () => new Promise((done) => server.close(done)) });
    });
  });
}
