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
