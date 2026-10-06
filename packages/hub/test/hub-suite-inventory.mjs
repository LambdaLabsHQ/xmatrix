import { readdirSync } from "node:fs";

/**
 * Files excluded from the default Hub suite (still discoverable when
 * XMATRIX_HUB_TEST_CAMPAIGN=1 / --campaign). Empty after migration dual-path
 * retirement: legacy attachment-source campaign e2e was deleted with the mappers.
 */
export const HUB_SUITE_DEFAULT_EXCLUDES = Object.freeze([]);

export function hubSuiteIncludesCampaign({
  env = process.env,
  argv = process.argv,
} = {}) {
  if (argv.includes("--campaign")) return true;
  const raw = env.XMATRIX_HUB_TEST_CAMPAIGN;
  return raw === "1" || raw === "true" || raw === "yes";
}

export function listHubSuiteFiles(testDir, {
  includeCampaign = hubSuiteIncludesCampaign(),
} = {}) {
  return readdirSync(testDir)
    .filter((file) => file.endsWith(".test.mjs") || file.endsWith(".e2e.mjs"))
    .filter((file) => includeCampaign || !HUB_SUITE_DEFAULT_EXCLUDES.includes(file))
    .sort();
}
