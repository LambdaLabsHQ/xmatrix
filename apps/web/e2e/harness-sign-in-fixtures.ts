import type { Page } from "@playwright/test";
import { fixtureJson } from "./workspace-fixtures";

/** Claude Code's paste-code sign-in as its machine answers it: the start shows
 * the browser link, and the finish settles signed in. */
export async function fixtureClaudePasteCodeSignIn(page: Page, start: string, finish: string) {
  await fixtureJson(page, "sign-in-start", `**/api/xmatrix/machine-daemons/harness-actions/${encodeURIComponent(start)}`, {
    controlId: start, presetId: "claude", action: "login_start", status: "succeeded",
    result: { presetId: "claude", action: "login_start", status: "succeeded", login: { state: "awaiting_user",
      flow: "url_paste_code", verificationUri: "https://claude.com/cai/oauth/authorize?code=true&state=e2e" } } });
  await fixtureJson(page, "sign-in-finish", `**/api/xmatrix/machine-daemons/harness-actions/${encodeURIComponent(finish)}`, {
    controlId: finish, presetId: "claude", action: "login_finish", status: "succeeded",
    result: { presetId: "claude", action: "login_finish", status: "succeeded",
      login: { state: "signed_in", flow: "url_paste_code" } } });
}
