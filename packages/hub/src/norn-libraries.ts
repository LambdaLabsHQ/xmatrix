import {
  readLibrary,
  type ConnectorEventSpec,
  type ConnectorManifest,
  type HostInterface,
  type Library,
} from "./vendor/norn/frontend/check/index";

/**
 * Connector event manifests and built-in Norn application libraries (`GitHub`,
 * `Gmail`) layered on the standard `Events` capability interface
 * (docs/architecture/norn-host.md).
 *
 * Keeping domain concepts (`GitHub.ciFailed`, `GitHub.issueOpened`,
 * `Gmail.receivedAt`) in pure Norn libraries means the host only exposes one
 * stable CloudEvents 1.0.2 capability (`Events`), while sensitive filtering
 * (such as Gmail recipient/subject matching) runs inside the owner's authorized
 * scope and emits only a PII-free `mailRef = { messageId }` for public Channels.
 */

const field = (name: string, type: string, required = true) => ({ name, type, required });
const summaryEvent = (kind: string): ConnectorEventSpec => ({
  kind,
  fields: [field("summary", "string"), field("url", "string", false)],
});
const summaryManifest = (app: string, kinds: readonly string[]): ConnectorManifest => ({
  app,
  events: kinds.map(summaryEvent),
});
const GITHUB_BRANCH_FIELDS = [field("branch", "string"), field("defaultBranch", "string"), field("url", "string")];

export const NORN_CONNECTOR_EVENT_MANIFESTS: readonly ConnectorManifest[] = [
  {
    app: "github",
    events: [
      { kind: "issues.opened", fields: [field("number", "int"), field("title", "string"), field("author", "string"), field("url", "string")] },
      { kind: "workflow_run.completed", fields: [field("workflow", "string"), field("conclusion", "string"), ...GITHUB_BRANCH_FIELDS] },
      { kind: "pull_request.closed", fields: [field("number", "int"), field("title", "string"), field("merged", "bool"), ...GITHUB_BRANCH_FIELDS] },
    ],
  },
  {
    app: "gmail",
    events: [
      { kind: "message.received", fields: [field("messageId", "string"), field("to", "list<string>"), field("subject", "string"), field("from", "string", false)] },
    ],
  },
  summaryManifest("sentry", ["issue.created", "issue.resolved"]),
  summaryManifest("stripe", ["invoice.payment_failed", "charge.succeeded"]),
  summaryManifest("vercel", ["deployment.error", "deployment.succeeded"]),
  summaryManifest("linear", ["issue.created", "issue.updated"]),
  summaryManifest("appstoreconnect", ["review.created"]),
];

/** Declared event kinds and fields for a connected app provider (surfaced in `xmatrix connector list`). */
export function nornConnectorEventSpecs(providerId: string): readonly ConnectorEventSpec[] {
  return NORN_CONNECTOR_EVENT_MANIFESTS.find(manifest => manifest.app === providerId)?.events ?? [];
}

/** Built-in `GitHub` application library built on the `Events` standard capability. */
export const NORN_GITHUB_LIBRARY = `/** GitHub repository events built on the standard Events capability. */
pub type issue = { number: int, title: string, author: string, url: string }
pub type ciFailure = { workflow: string, branch: string, conclusion: string, url: string }
pub type mergedPr = { number: int, title: string, branch: string, url: string }

type workflowData = { workflow: string, conclusion: string, branch: string, defaultBranch: string, url: string }
type pullData = { number: int, title: string, merged: bool, branch: string, defaultBranch: string, url: string }

let issueKind: Events.kind<issue> = Events.kind("github", "issues.opened")
let workflowKind: Events.kind<workflowData> = Events.kind("github", "workflow_run.completed")
let pullKind: Events.kind<pullData> = Events.kind("github", "pull_request.closed")

/** Stream of newly opened issues on \`repo\` ("owner/repo"). */
pub let issueOpened = (repo: string) =>
  Events.events(issueKind, ~source=repo)->map(env => env.data)

/** Stream of failed workflow runs on \`repo\`'s default branch. */
pub let ciFailed = (repo: string) =>
  Events.events(workflowKind, ~source=repo)->filterMap(env =>
    if env.data.conclusion == "failure" && env.data.branch == env.data.defaultBranch {
      Some({ workflow: env.data.workflow, branch: env.data.branch, conclusion: env.data.conclusion, url: env.data.url })
    } else {
      None
    })

/** Stream of pull requests merged into \`repo\`'s default branch. */
pub let prMerged = (repo: string) =>
  Events.events(pullKind, ~source=repo)->filterMap(env =>
    if env.data.merged && env.data.branch == env.data.defaultBranch {
      Some({ number: env.data.number, title: env.data.title, branch: env.data.branch, url: env.data.url })
    } else {
      None
    })
`;

/**
 * Built-in `Gmail` application library built on the `Events` standard capability.
 *
 * Filters incoming mail inside the owner's authorized scope and exposes ONLY
 * `mailRef = { messageId }` so email addresses, subjects, and bodies never leak
 * into public Channel `~about` blocks.
 */
export const NORN_GMAIL_LIBRARY = `/** Gmail mailbox events built on the standard Events capability. */
pub type mailRef = { messageId: string }

type mailData = { messageId: string, to: list<string>, subject: string }

let mailKind: Events.kind<mailData> = Events.kind("gmail", "message.received")

/**
 * Stream of stable message references for mail addressed to \`address\`
 * (and optionally matching \`~subjectContains\`). Filtering happens inside the
 * authorized scope; downstream requests receive only \`mailRef\` (zero PII).
 */
pub let receivedAt = (address: string, ~subjectContains: string="") =>
  Events.events(mailKind)->filterMap(env => {
    let target = String.toLowerCase(address)
    let matchedTo = List.some(env.data.to, a => String.toLowerCase(a) == target)
    let matchedSubject = subjectContains == "" || String.includes(String.toLowerCase(env.data.subject), String.toLowerCase(subjectContains))
    if matchedTo && matchedSubject {
      Some({ messageId: env.data.messageId })
    } else {
      None
    }
  })
`;

export const BUILTIN_NORN_LIBRARY_SOURCES: Readonly<Record<string, string>> = {
  GitHub: NORN_GITHUB_LIBRARY,
  Gmail: NORN_GMAIL_LIBRARY,
};

/** Checks and returns all built-in application libraries against `host` and `NORN_CONNECTOR_EVENT_MANIFESTS`. */
export function loadBuiltinNornLibraries(host: HostInterface): Readonly<Record<string, Library>> {
  const result: Record<string, Library> = {};
  for (const [name, source] of Object.entries(BUILTIN_NORN_LIBRARY_SOURCES)) {
    const lib = readLibrary(source, `${name}.norn`, host, { name });
    if (!lib.ok) {
      throw new Error(`Built-in Norn library ${name} failed to check: ${lib.diagnostics.map(d => d.message).join("; ")}`);
    }
    result[name] = lib;
  }
  return result;
}

/**
 * Extracts structured Gmail metadata (`to`, `subject`, `from`) from an
 * owner-authorized auto-read rendering for internal `Events` filtering.
 * Never exposed to public Channels — `Gmail.receivedAt` projects only `messageId`.
 */
export function extractGmailEventData(
  messageId: string,
  mailboxAddress: string,
  privateDetail?: string,
): { messageId: string; to: string[]; subject: string; from: string } {
  let subject = "";
  let from = "";
  const toSet = new Set<string>();
  if (privateDetail) {
    const lines = privateDetail.split(/\r?\n/u).slice(0, 20);
    for (const rawLine of lines) {
      const subjectMatch = /^Subject:\s*(.+)$/iu.exec(rawLine);
      if (subjectMatch && !subject) subject = subjectMatch[1]!.trim();
      const fromMatch = /^From:\s*(.+)$/iu.exec(rawLine);
      if (fromMatch && !from) from = fromMatch[1]!.trim();
      const toMatch = /^(?:To|Cc|Delivered-To):\s*(.+)$/iu.exec(rawLine);
      if (toMatch) {
        const emails = toMatch[1]!.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu) ?? [];
        for (const email of emails) toSet.add(email.toLowerCase());
      }
    }
  }
  if (toSet.size === 0 && mailboxAddress) toSet.add(mailboxAddress.toLowerCase());
  return { messageId, to: [...toSet], subject, from };
}
