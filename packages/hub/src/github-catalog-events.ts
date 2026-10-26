import { plainRecord } from "@xmatrix/protocol";
import { appRepository } from "./apps";
import { notifyWorkspaceResource } from "./workspace-resource-notification";
import type { Env } from "./types";

// These events change names, visibility, activity or the linker's administration.
const CATALOG_EVENTS = new Set(["installation", "installation_repositories", "repository", "push",
  "member", "membership", "organization"]);

/** Called only after the GitHub webhook signature has passed. Events carry no
 * catalog facts to clients: each affected Space re-reads the authorized catalog. */
export async function githubCatalogChanged(env: Env, event: string, payload: Record<string, unknown>) {
  if (!CATALOG_EVENTS.has(event)) return;
  const id = plainRecord(payload.installation)?.id;
  const installationId = typeof id === "number" && Number.isSafeInteger(id) ? String(id)
    : typeof id === "string" ? id : "";
  if (!/^[1-9][0-9]{0,19}$/u.test(installationId)) return;
  const spaceIds = await appRepository(env).invalidateGitHubRepositoryCatalog({ requestId: crypto.randomUUID(),
    installationId, limit: 1000 });
  await notifyWorkspaceResource(env, { spaceIds, resource: "launch_targets" });
}
