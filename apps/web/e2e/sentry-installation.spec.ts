import { expect, test, type Page } from "./fixtures";

const installationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const callback = `/connect/sentry?code=synthetic-one-use-code&installationId=${installationId}&orgSlug=made-by-robot`;
const spaces = [
  { id: "owned", name: "Company work", ownerId: "e2e-user", members: [] },
  { id: "admin", name: "Admin work", ownerId: "other", members: [{ userId: "e2e-user", role: "admin" }] },
  { id: "member", name: "Unprivileged work", ownerId: "other", members: [{ userId: "e2e-user", role: "member" }] },
];

async function installStubs(page: Page, status = 503) {
  const writes: unknown[] = [];
  await page.route("**/api/xmatrix/spaces", route => route.fulfill({ json: { spaces } }));
  await page.route("**/api/xmatrix/spaces/*/app-connections/sentry/install", route => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ status, json: status === 200 ? { ok: true } : { error: "private-provider-error" } });
  });
  return writes;
}

async function confirmSpace(page: Page, name = "Admin work") {
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Confirm installation" }).click();
}

test("Sentry callback removes its code, requires an explicit admin Space and never retries an uncertain confirmation", async ({ page }) => {
  const writes = await installStubs(page);
  const response = await page.goto(callback);
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response?.headers()["cache-control"]).toContain("no-store");
  await expect(page).toHaveURL(/\/connect\/sentry$/u);
  await expect(page.getByText("made-by-robot", { exact: true })).toBeVisible();
  const selection = page.getByRole("combobox", { name: "xMatrix Space" });
  await expect(selection).toContainText("Choose a Space");
  await selection.click();
  await expect(page.getByRole("option")).toHaveText(["Company work", "Admin work"]);
  expect(writes).toHaveLength(0);
  await page.getByRole("option", { name: "Admin work" }).click();
  const confirm = page.getByRole("button", { name: "Confirm installation" });
  await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox").check();
  await confirm.click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("start a fresh installation");
  expect(writes).toEqual([{ code: "synthetic-one-use-code", installationId, organization: "made-by-robot", confirmed: true }]);
  await expect(confirm).toBeDisabled();
  await expect(selection).toBeDisabled();
  await expect(page.locator("body")).not.toContainText("private-provider-error");
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })))
    .not.toContain("synthetic-one-use-code");
});

test("a successful confirmation returns to the selected Space's Sentry detail exactly once", async ({ page }) => {
  const writes = await installStubs(page, 200);
  await page.route("**/app/admin/apps?connector=sentry&oauth=connected", route => route.fulfill({
    contentType: "text/html", body: "<main>Sentry connected</main>",
  }));
  await page.goto(callback);
  await confirmSpace(page);
  await expect(page).toHaveURL(/\/app\/admin\/apps\?connector=sentry&oauth=connected$/u);
  expect(writes).toHaveLength(1);
});

test("invalid callback metadata never submits an installation", async ({ page }) => {
  const writes = await installStubs(page);
  await page.goto("/connect/sentry?code=synthetic-one-use-code&installationId=../other&orgSlug=made-by-robot");
  await expect(page).toHaveURL(/\/connect\/sentry$/u);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("missing or invalid");
  await expect(page.getByRole("button", { name: "Confirm installation" })).toBeDisabled();
  expect(writes).toHaveLength(0);
});

test("legacy organization spelling remains bounded to the same explicit installation", async ({ page }) => {
  const writes = await installStubs(page);
  await page.goto(callback.replace("orgSlug=", "sentryOrgSlug="));
  await expect(page.getByText("made-by-robot", { exact: true })).toBeVisible();
  await confirmSpace(page);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("start a fresh installation");
  expect(writes).toEqual([{ code: "synthetic-one-use-code", installationId, organization: "made-by-robot", confirmed: true }]);
});

test("conflicting or repeated callback identities cannot consume a code", async ({ page }) => {
  const writes = await installStubs(page);
  for (const suffix of ["&sentryOrgSlug=other-org", "&orgSlug=made-by-robot", "&installationId=" + installationId, "&code=another-code"]) {
    await page.goto(callback + suffix);
    await expect(page).toHaveURL(/\/connect\/sentry$/u);
    await expect(page.getByRole("main").getByRole("alert")).toContainText("missing or invalid");
    await expect(page.getByRole("button", { name: "Confirm installation" })).toBeDisabled();
  }
  expect(writes).toHaveLength(0);
});

test("signed-out callbacks keep codes out of login URLs and resume on a real auth focus refresh", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__xmatrixDisableMockAuth = true; });
  let signedIn = false;
  await page.route("**/api/auth/get-session**", route => route.fulfill({ json: signedIn ? {
    user: { id: "e2e-user", email: "e2e@xmatrix.test", name: "E2E Tester" },
    session: { token: "test-session", expiresAt: "2099-01-01T00:00:00.000Z" },
  } : null }));
  await page.route("**/api/auth/token**", route => route.fulfill({ json: { token: "test-jwt" } }));
  const writes = await installStubs(page);
  await page.goto(callback);
  const login = page.getByRole("link", { name: "Sign in to xMatrix" });
  await expect(login).toHaveAttribute("href", "/login?next=%2Fapp");
  await expect(login).toHaveAttribute("target", "_blank");
  await expect(login).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page).toHaveURL(/\/connect\/sentry$/u);
  signedIn = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("combobox")).toBeVisible();
  await confirmSpace(page, "Company work");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("start a fresh installation");
  expect(writes).toHaveLength(1);
});
