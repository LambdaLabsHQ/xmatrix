import { startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";

/**
 * A Hub worker whose mock session is one signed-in owner, for routes that
 * act as that person. `call` returns status and parsed JSON; a call with
 * `{ anonymous: true }` sends no session, as a terminal before sign-in does.
 */
export async function withOwnerWorker(name, check) {
  const token = `owner-${crypto.randomUUID()}`;
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: token,
    XMATRIX_MOCK_AUTH_USER_ID: `owner-user-${crypto.randomUUID()}`,
    XMATRIX_MOCK_AUTH_EMAIL: "owner@example.com",
    XMATRIX_MOCK_AUTH_NAME: name,
  } });
  const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
  const call = async (path, { method = "GET", body, bearer, anonymous = false } = {}) => {
    const response = await worker.fetch(path, {
      method,
      headers: anonymous ? { "content-type": "application/json" }
        : bearer ? { ...headers, Authorization: `Bearer ${bearer}` } : headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  try {
    await check({ worker, token, headers, call });
  } finally {
    await worker.stop();
  }
}
