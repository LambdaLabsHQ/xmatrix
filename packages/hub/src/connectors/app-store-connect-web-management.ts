import { canonicalJsonStringify, sha256Hex } from "@xmatrix/protocol";
import { appleResource, relation, type AppleResource } from "./app-store-connect-api";
import { appWebAction, webSession, type WebSession } from "./app-store-connect-web";
import { appVersion, EDITABLE_STATES, jsonFields, namedVersion, versionRef, versionState } from "./actions/app-store-connect";
import { cell } from "./actions/google-report";
import { record, text } from "./event-format";
import { ConnectorRemedy, ProviderRequestError } from "./http";
import type { ConnectorAction } from "./provider";

// Current private contracts: fastlane spaceship/connect_api/tunes/tunes.rb and models/sandbox_tester.rb.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>.]+(?:\.[^\s@<>.]+)+$/u;
const RESET = "/iris/v1/resetRatingsRequests";
const TESTERS = "/iris/v1/sandboxTesters";

async function resetRequest(session: WebSession, version: AppleResource) {
  let response: Record<string, unknown>;
  try { response = await session.read(`/iris/v1/appStoreVersions/${encodeURIComponent(version.id)}/resetRatingsRequest`); }
  catch (error) { if (error instanceof ProviderRequestError && error.status === 404) return undefined; throw error; }
  if (response.data === null) return undefined;
  const row = appleResource(response.data);
  if (!row || row.type !== "resetRatingsRequests" || !ID.test(row.id)) throw new ProviderRequestError(502, "Apple returned a malformed rating-reset request");
  return row;
}
const digest = (version: AppleResource, reset?: AppleResource) => sha256Hex(canonicalJsonStringify({ version: version.id,
  state: versionState(version), reset: reset ?? null }));

interface SandboxProfile {
  firstName: string; lastName: string; email: string; password: string; secretQuestion: string; secretAnswer: string;
  birthDate: string; appStoreTerritory: string;
}
function sandboxProfile(value: string | undefined, email: string): SandboxProfile {
  const fields = value && value.length <= 5_000 ? jsonFields(value) : undefined;
  const names = ["firstName", "lastName", "email", "password", "secretQuestion", "secretAnswer", "birthDate", "appStoreTerritory"];
  const valid = fields && Object.keys(fields).length === names.length && names.every(name => typeof fields[name] === "string" &&
    text(fields[name]).length > 0 && text(fields[name]).length <= (name === "password" ? 128 : 200));
  const date = valid ? text(fields.birthDate) : "", password = valid ? text(fields.password) : "";
  if (!valid || !EMAIL.test(text(fields.email)) || text(fields.email).toLowerCase() !== email || !/^[A-Z]{3}$/u.test(text(fields.appStoreTerritory)) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date ||
    password.length < 8 || !/[A-Z]/u.test(password) || !/[a-z]/u.test(password) || !/\d/u.test(password) || !/[^A-Za-z0-9]/u.test(password) ||
    text(fields.secretQuestion).length < 6 || text(fields.secretAnswer).length < 6) {
    throw new ConnectorRemedy(400, "Save a complete Sandbox tester setup in App Store Connect Credentials; its email must match the command. No private fields belong in Channel text", { kind: "credential", field: "sandboxTester" });
  }
  return fields as unknown as SandboxProfile;
}

/** Absence is proven across a bounded complete list; an incomplete or malformed list cannot authorize account creation. */
async function existingTester(session: WebSession, email: string): Promise<AppleResource | undefined> {
  let path = TESTERS;
  const visited = new Set<string>();
  for (let page = 0; page < 5; page++) {
    if (visited.has(path)) throw new ProviderRequestError(502, "Apple repeated a sandbox tester page");
    visited.add(path);
    const result = await session.read(path, page ? {} : { limit: "200" });
    if (!Array.isArray(result.data) || result.data.length > 200) throw new ProviderRequestError(502, "Apple returned a malformed sandbox tester list");
    const rows = result.data.map(appleResource);
    if (rows.some(row => !row || row.type !== "sandboxTesters" || !ID.test(row.id) || !EMAIL.test(text(row.attributes.email)))) {
      throw new ProviderRequestError(502, "Apple omitted sandbox tester identity data");
    }
    const matches = rows.filter(row => text(row!.attributes.email).toLowerCase() === email);
    if (matches.length > 1) throw new ProviderRequestError(409, "Apple returned multiple sandbox testers for this email");
    if (matches.length) return matches[0]!;
    const next = record(result.links).next;
    if (next === undefined || next === null) return undefined;
    if (typeof next !== "string" || !URL.canParse(next, "https://appstoreconnect.apple.com")) throw new ProviderRequestError(502, "Apple returned an invalid sandbox tester page");
    const url = new URL(next, "https://appstoreconnect.apple.com");
    if (url.origin !== "https://appstoreconnect.apple.com" || url.pathname !== TESTERS || url.username || url.password || url.hash) {
      throw new ProviderRequestError(502, "Apple returned a sandbox tester page outside its collection");
    }
    path = url.href;
  }
  throw new ProviderRequestError(502, "Sandbox tester history exceeds five pages; no account was created");
}

export const APP_STORE_CONNECT_WEB_MANAGEMENT_ACTIONS: Record<string, ConnectorAction> = {
  rating_reset: appWebAction("read", appVersion, async (session, app, input, api) => {
    const { version } = await namedVersion(api, app.id, input), reset = await resetRequest(session, version);
    return { summary: `${input.app} ${input.version}: rating reset ${reset ? `scheduled (${cell(reset.id)})` : "not scheduled"}; ` +
      `digest ${await digest(version, reset)}. Scheduling applies when this version is released; it does not remove written reviews.` };
  }),
  set_rating_reset: appWebAction("write", statement => {
    const [word = "", state, expected, ...rest] = statement.text.trim().split(/\s+/u), ref = versionRef(word);
    const app = appVersion({ ...statement, text: word });
    return typeof app !== "string" && ref && !rest.length && ["on", "off"].includes(state!) && /^[a-f0-9]{64}$/u.test(expected ?? "")
      ? { ...app, state: state!, digest: expected! } : "name app, editable version, on|off and the current digest from rating_reset";
  }, async (session, app, input, api) => {
    const { version } = await namedVersion(api, app.id, input), reset = await resetRequest(session, version);
    if (!EDITABLE_STATES.has(versionState(version))) throw new ProviderRequestError(409, "Rating reset can be changed only for an editable version");
    if (await digest(version, reset) !== input.digest) throw new ProviderRequestError(409, "The rating-reset snapshot changed; read rating_reset again");
    if (input.state === "on" && !reset) await session.send("POST", RESET, { data: { type: "resetRatingsRequests",
      relationships: { appStoreVersion: relation("appStoreVersions", version.id) } } });
    else if (input.state === "off" && reset) await session.send("DELETE", `${RESET}/${encodeURIComponent(reset.id)}`);
    const verified = await resetRequest(session, version);
    if (Boolean(verified) !== (input.state === "on")) throw new ProviderRequestError(502, "Apple's rating-reset change could not be verified; inspect before retrying");
    return { summary: `${input.app} ${input.version}: rating reset ${verified ? "scheduled for this version's release" : "not scheduled"}. No version was released.` };
  }),
  create_sandbox_tester: {
    effect: "write", requires: ["webSession", "sandboxTester"],
    parse: statement => EMAIL.test(statement.target) && statement.target.length <= 254 && !statement.text.trim()
      ? { email: statement.target.toLowerCase() } : "name only the email matching Sandbox tester setup in Credentials; never include a password",
    async execute(context, input) {
      const profile = sandboxProfile(context.credentials.sandboxTester, input.email!), session = webSession(context);
      try {
        const existing = await existingTester(session, input.email!);
        if (existing) return { summary: `Sandbox tester ${cell(existing.id)} already exists for ${cell(input.email)}; no password or account setting was changed.` };
        const created = appleResource((await session.sendPrivate("POST", TESTERS, { data: { type: "sandboxTesters",
          attributes: { ...profile, confirmPassword: profile.password } } })).data);
        if (!created || created.type !== "sandboxTesters" || !ID.test(created.id)) {
          throw new ProviderRequestError(502, "Apple's sandbox account creation outcome is uncertain; inspect before retrying");
        }
        const verified = await existingTester(session, input.email!);
        if (verified?.id !== created.id) throw new ProviderRequestError(502, "Apple's new sandbox tester could not be verified; inspect before retrying");
        return { summary: `Created sandbox tester ${cell(created.id)} for ${cell(input.email)}. Private account fields remain in Credentials and Apple.` };
      } finally { await session.settle(); }
    },
  },
};
