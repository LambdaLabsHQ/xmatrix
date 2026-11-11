import type { ConnectorAction, ConnectorActionStatement } from "./provider";
import { providerJson, ProviderRequestError } from "./http";
import { record } from "./event-format";
import { describeGoogleError } from "./google-provider-error";
import { googleHeaders } from "./actions/google-headers";
import { columns, optionsJson, report, request } from "./gcp-common";

const MAX_REFERRERS = 10;
const MAX_TOTAL_REFERRERS = 1_200;
/* An optional scheme, one host (optionally one leading "*." label or localhost), an optional port and an optional path. */
const REFERRER = /^(?:https?:\/\/)?(?:\*\.)?(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62})(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~%!$&'()*+,;=:@/?-]*)?$/u;

function referrerOptions(statement: ConnectorActionStatement): Record<string, string> | string {
  const [projectNumber, key, ...rest] = statement.target.split("/");
  if (rest.length || !projectNumber || !/^[1-9][0-9]{5,19}$/u.test(projectNumber) || !key || !/^[a-z0-9-]{1,63}$/u.test(key)) {
    return "use <project-number>/<key-id>; list_api_keys shows key ids";
  }
  const raw = optionsJson(statement, ["referrers"]);
  if (typeof raw === "string") return raw;
  const referrers = raw.referrers;
  if (!Array.isArray(referrers) || !referrers.length || referrers.length > MAX_REFERRERS) return `referrers must list 1-${MAX_REFERRERS} website patterns`;
  for (const value of referrers) {
    if (typeof value !== "string" || value.length > 255 || !REFERRER.test(value)) {
      return "each referrer must name one website such as *.example.com/* or https://example.com/*; bare wildcards are refused";
    }
  }
  return { project: projectNumber, key, referrers: JSON.stringify([...new Set(referrers as string[])]) };
}

export const GCP_API_KEY_ACTIONS: Record<string, ConnectorAction> = {
  add_key_referrers: {
    effect: "write", requires: ["oauthToken"], parse: referrerOptions,
    async execute({ credentials }, input) {
      const name = `projects/${input.project}/locations/global/keys/${input.key}`;
      const current = await request(credentials, `https://apikeys.googleapis.com/v2/${name}`, undefined, input.project);
      if (current.name !== name) throw new ProviderRequestError(502, "Google Cloud returned another API key");
      const restrictions = record(current.restrictions);
      const browser = restrictions.browserKeyRestrictions;
      if (browser === undefined) {
        throw new ProviderRequestError(409, "This key has no website restriction; adding referrers would restrict it, so change it in the Google Cloud console instead");
      }
      const existing = record(browser).allowedReferrers ?? [];
      if (!Array.isArray(existing) || existing.some(value => typeof value !== "string")) throw new ProviderRequestError(502, "Google Cloud returned invalid website restrictions");
      const requested = JSON.parse(input.referrers!) as string[];
      const added = requested.filter(value => !existing.includes(value));
      const header = [columns("Key", name), columns("Display name", current.displayName)];
      if (!added.length) return report("API key website restrictions unchanged", [...header, "Every requested referrer is already allowed; nothing was written."], {});
      if (typeof current.etag !== "string" || !current.etag.trim()) {
        throw new ProviderRequestError(502, "Google Cloud returned no API key etag; the website restrictions were not changed");
      }
      if (existing.length + added.length > MAX_TOTAL_REFERRERS) throw new ProviderRequestError(400, "The key would exceed Google's website restriction limit");
      const url = new URL(`https://apikeys.googleapis.com/v2/${name}`);
      url.search = new URLSearchParams({ updateMask: "restrictions" }).toString();
      const result = await providerJson(url, { method: "PATCH", describeError: describeGoogleError,
        headers: { ...googleHeaders(credentials, "Google Cloud"), "x-goog-user-project": input.project },
        json: { restrictions: { ...restrictions, browserKeyRestrictions: { allowedReferrers: [...existing, ...added] } }, etag: current.etag } });
      const failure = record(result.error);
      return report("API key website restrictions update", [...header,
        columns("Added referrers", added.join(", ")), columns("Allowed referrers", `${existing.length} before, ${existing.length + added.length} after; none removed`),
        columns("Operation", result.name), columns("State", result.error ? "failed" : result.done === true ? "complete" : "pending"),
        ...(result.error ? [columns("Error code", failure.code)] : ["Google usually applies key restriction changes within five minutes."])], {});
    },
  },
};
