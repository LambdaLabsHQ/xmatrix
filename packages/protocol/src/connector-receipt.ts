import { APP_CONNECTOR_PROVIDER_MANIFESTS } from "./app-connector-manifests.js";

/** Both modes record the invocation; private originals stay outside shared history. */
export type ConnectorResultVisibility = "public" | "private";

export const PRIVATE_CONNECTOR_RESULT = "Result: [hidden — private call]";

const CONNECTOR_RECEIPT_HEADING = "App connector command status:";
const RECEIPT_STATUSES = ["completed", "failed", "blocked", "denied", "queued", "ignored"] as const;
export type ConnectorReceiptStatus = typeof RECEIPT_STATUSES[number];

/** One statement's outcome in a connector receipt, as a reader draws it. */
export interface ConnectorReceiptEntry {
  /** What ran, in the provider's own words when its manifest declares the action. */
  subject: string;
  status?: ConnectorReceiptStatus;
  /** What it returned or why it did not run; empty when the outcome says it all. */
  detail: string;
  /** A private call: shared readers receive a mask, with a separate Human owner view. */
  private: boolean;
}

/** The receipt a connector command gets in its Channel: one line per statement,
 * each `<subject>: <status>; <detail>`. Agents read it as text. */
export function connectorReceiptBody(lines: readonly string[]): string {
  return `${CONNECTOR_RECEIPT_HEADING}\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

const RECEIPT_LINE = new RegExp(`^(.+?):? (${RECEIPT_STATUSES.join("|")})(?:[;.] ?([\\s\\S]*))?$`, "u");

/** The entries of a receipt `connectorReceiptBody` wrote. Only the Hub writes
 * one, so callers read it only on an App's system fact. */
export function parseConnectorReceipt(body: string): ConnectorReceiptEntry[] | undefined {
  const [heading, ...rest] = body.trim().split(/\r?\n/u);
  if (heading?.trim() !== CONNECTOR_RECEIPT_HEADING || !rest[0]?.startsWith("- ")) return undefined;
  const lines: string[] = [];
  for (const line of rest) {
    if (line.startsWith("- ")) lines.push(line.slice(2));
    else lines[lines.length - 1] += `\n${line}`;
  }
  return lines.map((line) => {
    const match = RECEIPT_LINE.exec(line.trim());
    if (!match) return { subject: "", detail: line.trim(), private: false };
    const detail = (match[3] ?? "").trim().replace(/(?<=[\]\w)])\.$/u, "");
    const isPrivate = detail === PRIVATE_CONNECTOR_RESULT;
    return { subject: receiptSubject(match[1]!), status: match[2] as ConnectorReceiptStatus,
      detail: isPrivate ? "" : detail, private: isPrivate };
  });
}

/** `Google Search Console inspect_url` reads as the action's label, `Inspect URL`. */
function receiptSubject(subject: string): string {
  const manifest = APP_CONNECTOR_PROVIDER_MANIFESTS.find((candidate) => subject.startsWith(`${candidate.name} `));
  const action = manifest?.actions.find((candidate) => candidate.id === subject.slice(manifest.name.length + 1));
  return action?.label ?? subject;
}

/** A conversation row's one line for a receipt, from its truncated preview:
 * its first statement's action and outcome. */
export function connectorReceiptPreview(preview: string): string | undefined {
  if (!preview.startsWith(CONNECTOR_RECEIPT_HEADING)) return undefined;
  // Start only at whitespace-run boundaries, avoiding repeated suffix scans when no separator follows.
  const first = preview.slice(CONNECTOR_RECEIPT_HEADING.length).trim().replace(/^- /u, "")
    .split(/(?<!\s)\s+- (?=\S)/u, 1)[0]!;
  const match = RECEIPT_LINE.exec(first);
  if (!match) return first;
  const status = match[2]!;
  return `${receiptSubject(match[1]!)} · ${status[0]!.toUpperCase()}${status.slice(1)}`;
}

/**
 * What stopped a statement that a person can fix right under its receipt: the
 * credential field to save or the connection to make again. The Hub stores
 * these under a metadata key only it writes (`xmatrixConnectorFixes`), so the
 * card they draw names the Hub's own fix, never one a message invented.
 */
export interface ConnectorReceiptFix {
  providerId: string;
  actionId: string;
  /** The execution whose read can run again once the fix is in; none on a card an Agent asked for. */
  executionId?: string;
  remedy: { kind: "credential"; field: string } | { kind: "reconnect" };
  /** A value the asking Agent suggests for a plain field, which a person confirms before it is saved. */
  proposed?: string;
}

/** Metadata key of a receipt's fixes. */
export const CONNECTOR_RECEIPT_FIXES_KEY = "xmatrixConnectorFixes";

const FIX_ID = /^[A-Za-z0-9._:-]{1,240}$/u;

/** A suggested plain value: one short line of printable text. */
export function proposedValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // eslint-disable-next-line no-control-regex
  return trimmed && trimmed.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(trimmed) ? trimmed : undefined;
}

/** A receipt's fixes, keeping only well-formed ones for a known App. */
export function connectorReceiptFixesOf(metadata: Record<string, unknown> | undefined): ConnectorReceiptFix[] {
  const value = metadata?.[CONNECTOR_RECEIPT_FIXES_KEY];
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((item): ConnectorReceiptFix[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const fix = item as Record<string, unknown>;
    const remedy = fix.remedy && typeof fix.remedy === "object" ? fix.remedy as Record<string, unknown> : undefined;
    const manifest = APP_CONNECTOR_PROVIDER_MANIFESTS.find((candidate) => candidate.id === fix.providerId);
    if (!manifest || typeof fix.actionId !== "string" || !FIX_ID.test(fix.actionId) || !remedy ||
      (fix.executionId !== undefined && (typeof fix.executionId !== "string" || !FIX_ID.test(fix.executionId)))) return [];
    const base = { providerId: manifest.id, actionId: fix.actionId,
      ...(typeof fix.executionId === "string" ? { executionId: fix.executionId } : {}) };
    if (remedy.kind === "reconnect") return [{ ...base, remedy: { kind: "reconnect" } }];
    const field = manifest.credentials?.find((candidate) => candidate.id === remedy.field);
    if (remedy.kind !== "credential" || !field || field.generated || field.managed) return [];
    const proposed = field.plain ? proposedValue(fix.proposed) : undefined;
    return [{ ...base, remedy: { kind: "credential", field: field.id }, ...(proposed ? { proposed } : {}) }];
  });
}

/** Metadata key of a card an Agent posted to ask for settings (`xmatrix request settings`). */
export const SETTINGS_REQUEST_KEY = "xmatrixSettingsRequest";

/** Where a fix's setting lives: `connector:<app>/<field>`, or `connector:<app>/connect` for the connection itself. */
export function settingAddress(fix: Pick<ConnectorReceiptFix, "providerId" | "remedy">): string {
  return `connector:${fix.providerId}/${fix.remedy.kind === "credential" ? fix.remedy.field : "connect"}`;
}

/** The fix a setting address names, when it names a known App's typed field or its connection. */
export function settingAddressFix(address: string): Omit<ConnectorReceiptFix, "executionId"> | undefined {
  const match = /^connector:([a-z0-9-]{1,80})\/([A-Za-z0-9_]{1,80})$/u.exec(address.trim());
  if (!match) return undefined;
  const remedy = match[2] === "connect" ? { kind: "reconnect" } : { kind: "credential", field: match[2] };
  return connectorReceiptFixesOf({ [CONNECTOR_RECEIPT_FIXES_KEY]: [{ providerId: match[1], actionId: "settings", remedy }] })[0];
}

/** The connection as a settings card reads it. */
export interface SettingsConnectionState {
  status: string;
  lastCheckedAt?: string;
  credentialFields?: string[];
}

/**
 * Whether a connection now has what a fix asked for: the Hub checked it after
 * the card was written, the check passed, and a field it lacked is saved.
 */
export function connectorFixSettled(fix: Pick<ConnectorReceiptFix, "remedy">, connection: SettingsConnectionState | undefined,
  askedAt: string): boolean {
  if (!connection || connection.status !== "configured" || !connection.lastCheckedAt) return false;
  if (Date.parse(connection.lastCheckedAt) <= Date.parse(askedAt)) return false;
  return fix.remedy.kind !== "credential" || !connection.credentialFields || connection.credentialFields.includes(fix.remedy.field);
}
