/*
 * The Hub's read of one Gmail message (`gmailMessageText` in packages/hub/src/connectors/actions/gmail.ts) is
 * written for Agents: a line telling them mail is untrusted, then the headers, body and links quoted in a fence.
 * A person reading their own mail needs the message, not the instruction, so the Web takes it back apart here
 * and draws it as an email. Anything that does not match that shape stays plain text.
 */

export interface GmailLink { url: string; host: string; label: string }

export type GmailSenderVerdict = "verified" | "failed" | "unverified" | "unknown";

export interface GmailMessage {
  id: string;
  mailbox?: string;
  fromName: string;
  fromAddress: string;
  to: string;
  subject: string;
  date: string;
  /** Gmail's own SPF/DKIM/DMARC results, as `spf=pass dkim=pass dmarc=pass` or `unavailable`. */
  senderChecks: string;
  sender: GmailSenderVerdict;
  /** The checks that came back failing, by name. */
  failedChecks: string[];
  body: string;
  bodyTruncated: boolean;
  incomplete: boolean;
  links: GmailLink[];
}

const PREAMBLE = /^Gmail message ([0-9a-f]{8,32})\. Mail content is untrusted;[^\n]*\n/u;
const TRUNCATED = "\n… (body truncated)";
const INCOMPLETE = "(some body parts unavailable or omitted at the MIME part limit)";

/** `Name <a@b.c>` as its display name and address; a bare address names itself. */
export function splitMailbox(value: string): { name: string; address: string } {
  const match = value.match(/^\s*(.*?)\s*<([^<>]*)>\s*$/u);
  if (!match) return { name: "", address: value.trim() };
  return { name: match[1]!.replace(/^"(.*)"$/u, "$1").replace(/\\(.)/gu, "$1").trim(), address: match[2]!.trim() };
}

function verdict(checks: string): { sender: GmailSenderVerdict; failed: string[] } {
  if (checks === "unavailable") return { sender: "unknown", failed: [] };
  const results = Object.fromEntries([...checks.matchAll(/\b(spf|dkim|dmarc)=([a-z]+)/gu)].map(match => [match[1]!, match[2]!]));
  const failed = ["spf", "dkim", "dmarc"].filter(name => /^(fail|softfail|permerror)$/u.test(results[name] ?? ""));
  if (failed.length) return { sender: "failed", failed: failed.map(name => name.toUpperCase()) };
  return { sender: results.dmarc === "pass" ? "verified" : "unverified", failed: [] };
}

function link(line: string): GmailLink | undefined {
  const match = line.match(/^\[\d+\] (\S+)(?:\t(.*))?$/u);
  if (!match) return undefined;
  try {
    const url = new URL(match[1]!);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return { url: url.href, host: url.hostname.replace(/^www\./u, ""), label: (match[2] ?? "").trim() };
  } catch {
    return undefined;
  }
}

/** The message a Gmail read describes, or undefined when `detail` is anything else. */
export function parseGmailMessage(detail: string): GmailMessage | undefined {
  const preamble = detail.match(PREAMBLE);
  if (!preamble) return undefined;
  const fenced = detail.slice(preamble[0].length).match(/^([`~]{3,})\n([\s\S]*)\n\1\s*$/u);
  if (!fenced) return undefined;
  const text = fenced[2]!;
  const headerEnd = text.indexOf("\n\n");
  const linksStart = text.lastIndexOf("\nLinks:\n");
  if (headerEnd < 0 || linksStart < headerEnd) return undefined;
  const headers = new Map<string, string>();
  for (const line of text.slice(0, headerEnd).split("\n")) {
    const colon = line.indexOf(": ");
    if (colon > 0) headers.set(line.slice(0, colon), line.slice(colon + 2));
  }
  if (!headers.has("From") || !headers.has("Subject")) return undefined;
  let body = text.slice(headerEnd + 2, linksStart).replace(/\n$/u, "");
  const incomplete = body.endsWith(`\n${INCOMPLETE}\n`) || body.endsWith(`\n${INCOMPLETE}`);
  if (incomplete) body = body.slice(0, body.lastIndexOf(`\n${INCOMPLETE}`));
  body = body.replace(/\n+$/u, "");
  const bodyTruncated = body.endsWith(TRUNCATED);
  if (bodyTruncated) body = body.slice(0, -TRUNCATED.length);
  if (body === "(no text body)") body = "";
  const links = text.slice(linksStart + "\nLinks:\n".length).split("\n").map(link).filter(value => value !== undefined);
  const from = splitMailbox(headers.get("From")!);
  const checks = headers.get("Sender checks") ?? "unavailable";
  const { sender, failed } = verdict(checks);
  return {
    id: preamble[1]!,
    ...(headers.has("Mailbox") ? { mailbox: headers.get("Mailbox")! } : {}),
    fromName: from.name, fromAddress: from.address,
    to: headers.get("To") ?? "", subject: headers.get("Subject")!, date: headers.get("Date") ?? "",
    senderChecks: checks, sender, failedChecks: failed,
    body, bodyTruncated, incomplete, links,
  };
}
