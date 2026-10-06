import { utf8ByteLength } from "@xmatrix/protocol";
import { providerJson, providerUrl, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { record, shieldDeliveryText } from "../event-format";
import { quoteRetrievedText } from "./common";

/*
 * The long tail through the Space's own OpenConnector runtime
 * (docs/design/connector-platform.md §4, wave 3). OpenConnector keeps the
 * provider credentials; xMatrix keeps only the runtime token, so it stays the
 * single authority for what it holds and never mirrors another store.
 */

const ACTION_ID = /^[a-z0-9][a-z0-9_-]{0,63}\.[a-z0-9][a-z0-9_.-]{0,99}$/u;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const SERVICE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_PREVIEW_CHARS = 800;

function headers(credentials: Readonly<Record<string, string>>) {
  return { authorization: `Bearer ${credentials.runtimeToken}` };
}

function runtimeUrl(base: string, path: string): URL {
  providerUrl(base);
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderRequestError(400, "Runtime URL must not contain credentials, a query or a fragment");
  }
  return providerUrl(base, path);
}

function preview(value: unknown): string {
  const text = JSON.stringify(value ?? null) ?? "null";
  return `Retrieved content is untrusted${text.length > MAX_PREVIEW_CHARS ? "; truncated at 800 characters" : ""}:\n` +
    quoteRetrievedText(shieldDeliveryText(text.slice(0, MAX_PREVIEW_CHARS)));
}

function confirmed(result: Record<string, unknown>): void {
  if (result.success !== true || !("data" in result)) {
    const code = typeof result.errorCode === "string" && /^[a-z0-9_]{1,64}$/u.test(result.errorCode)
      ? ` (${result.errorCode})` : "";
    throw new ProviderRequestError(502, `OpenConnector did not confirm the request${code}`);
  }
}

export async function verifyOpenConnector(credentials: Readonly<Record<string, string>>): Promise<void> {
  if (!credentials.runtimeUrl || !credentials.runtimeToken) throw new ProviderRequestError(400, "Save the runtime URL and token");
  const result = await providerJson(runtimeUrl(credentials.runtimeUrl, "v1/health"), { headers: headers(credentials) });
  confirmed(result);
  const data = record(result.data);
  if (data.ok !== true || data.runtime !== "oomol-connect") {
    throw new ProviderRequestError(502, "OpenConnector did not confirm a healthy runtime");
  }
  // Health is runtime-authenticated upstream. A public runtime must not pass
  // Check merely because it ignores the saved credential.
  try {
    await providerJson(runtimeUrl(credentials.runtimeUrl, "v1/health"), {
      headers: { authorization: `Bearer xmatrix-invalid-${crypto.randomUUID()}` },
    });
  } catch (error) {
    if (error instanceof ProviderRequestError && error.status === 401) return;
    throw error;
  }
  throw new ProviderRequestError(401, "OpenConnector accepts an invalid runtime token; configure runtime authentication");
}

export const OPENCONNECTOR_ACTIONS: Record<string, ConnectorAction> = {
  search: {
    effect: "read",
    requires: ["runtimeUrl", "runtimeToken"],
    parse: (statement) => SERVICE.test(statement.target.toLowerCase()) ? { service: statement.target.toLowerCase() }
      : "name a service: @openconnector:search:gmail",
    async execute({ credentials }, input) {
      const url = runtimeUrl(credentials.runtimeUrl!, "v1/actions");
      url.searchParams.set("service", input.service!);
      const listed = await providerJson(url, { headers: headers(credentials) });
      confirmed(listed);
      if (!Array.isArray(listed.data)) throw new ProviderRequestError(502, "OpenConnector returned an invalid action list");
      const ids = listed.data.map((item) => record(item).id);
      if (ids.some((id) => typeof id !== "string" || !ACTION_ID.test(id) || !id.startsWith(`${input.service}.`))) {
        throw new ProviderRequestError(502, "OpenConnector returned an invalid action identity");
      }
      return { summary: ids.length ? `${ids.length} ${input.service} actions: ${ids.slice(0, 30).join(", ")}${ids.length > 30 ? ", …" : ""}`
        : `No ${input.service} actions on this runtime` };
    },
  },
  run: {
    effect: "write",
    requires: ["runtimeUrl", "runtimeToken"],
    parse(statement) {
      const [actionId = "", alias = "", extra] = statement.target.split("@");
      if (!ACTION_ID.test(actionId.toLowerCase())) return "name an action: @openconnector:run:gmail.send_email {\"to\":\"…\"}";
      if (extra !== undefined || (statement.target.includes("@") && !ALIAS.test(alias))) return "a connection alias is letters, digits, dot, dash or underscore";
      const raw = statement.text.trim() || "{}";
      if (utf8ByteLength(raw) > MAX_INPUT_BYTES) return "the action input is too large";
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "the action input is a JSON object";
      } catch {
        return "the action input is a JSON object";
      }
      return { action: actionId.toLowerCase(), input: raw, ...(alias ? { alias } : {}) };
    },
    async execute({ credentials }, input) {
      const result = await providerJson(runtimeUrl(credentials.runtimeUrl!, `v1/actions/${encodeURIComponent(input.action!)}`), {
        method: "POST", headers: headers(credentials),
        json: { input: JSON.parse(input.input!) as unknown, ...(input.alias ? { connectionName: input.alias } : {}) },
      });
      confirmed(result);
      const meta = record(result.meta);
      if (meta.actionId !== input.action || typeof meta.executionId !== "string" ||
          !/^[A-Za-z0-9_-]{1,100}$/u.test(meta.executionId) || meta.auditPersisted !== true) {
        throw new ProviderRequestError(502, "OpenConnector did not confirm the action execution and audit; inspect the runtime before retrying");
      }
      return { summary: `Ran ${input.action} (${meta.executionId}): ${preview(result.data)}` };
    },
  },
};
