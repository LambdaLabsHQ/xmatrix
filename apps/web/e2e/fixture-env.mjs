/**
 * Single source of truth for browser e2e production-server fixture env.
 * Used by Playwright webServer and the isolated e2e/build.mjs child process.
 */
export const WEB_E2E_FIXTURE_ENV = Object.freeze({
  NEXT_PUBLIC_XMATRIX_MOCK_AUTH_TOKEN: "xmatrix-e2e-mock-token",
  NEXT_PUBLIC_XMATRIX_MOCK_AUTH_USER_ID: "e2e-user",
  NEXT_PUBLIC_XMATRIX_MOCK_AUTH_EMAIL: "e2e@xmatrix.test",
  NEXT_PUBLIC_XMATRIX_MOCK_AUTH_NAME: "E2E Tester",
  NEXT_PUBLIC_XMATRIX_MOBILE_LIST_FIXTURE: "1",
  NEXT_PUBLIC_XMATRIX_RELAY_V2_BROWSER_FIXTURE: "1",
  NEXT_PUBLIC_XMATRIX_E2E_COMPATIBILITY_FIXTURE: "1",
  // Server-rendered pages (public pages) read the Hub from the Next server,
  // where in-page fixtures cannot reach; specs that need one serve it here.
  XMATRIX_E2E_SERVER_HUB_URL: "http://127.0.0.1:4697",
});
