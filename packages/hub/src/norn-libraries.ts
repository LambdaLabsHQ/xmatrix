import { APP_CONNECTOR_PROVIDER_MANIFESTS } from "@xmatrix/protocol";
import {
  readLibrary,
  type ConnectorActionSpec,
  type ConnectorEventSpec,
  type ConnectorManifest,
  type HostInterface,
  type Library,
} from "./vendor/norn/frontend/check/index";
import type { Value } from "./vendor/norn/runtime/value";

/**
 * Connector manifests and built-in Norn application libraries (`GitHub`,
 * `Gmail`, `X`) layered on the standard `Events` and `Actions` capability
 * interfaces (docs/architecture/norn-host.md).
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

/** What every action answers: the receipt's words, and the link it gave when it gave one. */
const ACTION_OUTPUT = [field("summary", "string"), field("url", "string", false)];
/** An action as a Channel command writes it: `@app:action:<target> <text>`. */
const commandAction = (name: string): ConnectorActionSpec => ({ name, input: [field("target", "string"), field("text", "string")], output: ACTION_OUTPUT });
/**
 * Actions whose input a program writes as named fields instead of a command's
 * target and text. Every other action a connected app declares takes the two
 * a command takes (`commandAction`).
 */
const FIELD_ACTIONS: Readonly<Record<string, readonly ConnectorActionSpec[]>> = {
  x: [
    { name: "post", input: [field("account", "string"), field("text", "string")], output: ACTION_OUTPUT },
    { name: "publish_video", input: [field("account", "string"), field("text", "string"), field("video", "string")], output: ACTION_OUTPUT },
  ],
};
/** The actions a program may ask of a connected app: every action the app declares, in the app's manifest. */
function manifestActions(app: string): readonly ConnectorActionSpec[] {
  // GitHub's commands run through its App's own pipeline, not through an action executor the host can hold a
  // request for: a program asks an Agent for those.
  if (app === "github") return [];
  const declared = APP_CONNECTOR_PROVIDER_MANIFESTS.find(manifest => manifest.id === app)?.actions ?? [];
  const fields = FIELD_ACTIONS[app] ?? [];
  return declared.filter(action => Boolean(action.effect)).map(action => fields.find(spec => spec.name === action.id) ?? commandAction(action.id));
}

const text = (value: Value | undefined): string | undefined => value?.type === "string" ? value.value : undefined;
/**
 * The command statement a program's action input stands for, as the
 * connector parses a Channel command: its target and its text. The connector
 * validates both as it does a command's, so nothing reaches a provider that a
 * command could not have sent.
 */
export function nornActionStatement(app: string, action: string, input: Value | null): { target: string; text: string } | { refusal: string } {
  const fields = input?.type === "record" ? input.fields : undefined;
  const missing = (names: string[]) => ({ refusal: `${app} ${action} takes ${names.join(", ")} as text` });
  if (app === "x" && (action === "post" || action === "publish_video")) {
    const account = text(fields?.account), words = text(fields?.text), video = text(fields?.video);
    if (account === undefined || words === undefined || (action === "publish_video" && video === undefined)) {
      return missing(action === "post" ? ["account", "text"] : ["account", "text", "video"]);
    }
    return { target: account, text: JSON.stringify(action === "post" ? { text: words } : { text: words, video }) };
  }
  const target = text(fields?.target), words = text(fields?.text);
  return target === undefined || words === undefined ? missing(["target", "text"]) : { target, text: words };
}

const EVENT_MANIFESTS: readonly ConnectorManifest[] = [
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
/** What a program can hear from and ask of each connected app: its event kinds and its actions. */
export const NORN_CONNECTOR_EVENT_MANIFESTS: readonly ConnectorManifest[] = [
  ...EVENT_MANIFESTS.map(manifest => ({ ...manifest, actions: manifestActions(manifest.app) })),
  ...APP_CONNECTOR_PROVIDER_MANIFESTS.filter(manifest => !EVENT_MANIFESTS.some(known => known.app === manifest.id))
    .map(manifest => ({ app: manifest.id, events: [], actions: manifestActions(manifest.id) })),
].filter(manifest => manifest.events.length > 0 || manifest.actions.length > 0);

/** The actions a program can ask of a connected app provider (surfaced in `xmatrix connector list`). */
export function nornConnectorActionSpecs(providerId: string): readonly ConnectorActionSpec[] {
  return NORN_CONNECTOR_EVENT_MANIFESTS.find(manifest => manifest.app === providerId)?.actions ?? [];
}

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

/**
 * Built-in `X` application library built on the `Actions` standard capability:
 * a post is prepared, which fixes the account, the text and the video and has
 * it admitted, and published later, with no Agent in between.
 */
export const NORN_X_LIBRARY = `/** Posts on X, built on the standard Actions capability. */
pub type posted = { summary: string, url: option<string> }

type post = { account: string, text: string }
type videoPost = { account: string, text: string, video: string }

let postAction: Actions.action<post, posted> = Actions.action("x", "post")
let videoAction: Actions.action<videoPost, posted> = Actions.action("x", "publish_video")

/**
 * Fixes one text post as \`account\` ("@handle" or the account ID) and has it
 * admitted under the X connection's permission. Nothing is posted yet.
 */
pub let preparePost = (account: string, text: string) =>
  Actions.prepare(postAction, { account, text })

/**
 * Fixes one post with a video: \`video\` is "<message ID>/<attachment ID>" of an
 * MP4 in the program's conversation. Nothing is uploaded or posted yet.
 */
pub let prepareVideo = (account: string, video: string, text: string) =>
  Actions.prepare(videoAction, { account, text, video })

/** Publishes what was prepared, once. The video is uploaded now. */
pub let publish = ready => Actions.perform(ready)
`;

export const BUILTIN_NORN_LIBRARY_SOURCES: Readonly<Record<string, string>> = {
  GitHub: NORN_GITHUB_LIBRARY,
  Gmail: NORN_GMAIL_LIBRARY,
  X: NORN_X_LIBRARY,
};

/** Checks and returns all built-in application libraries against `host` and `NORN_CONNECTOR_EVENT_MANIFESTS`. */
export function loadBuiltinNornLibraries(host: HostInterface): Readonly<Record<string, Library>> {
  const result: Record<string, Library> = {};
  for (const [name, source] of Object.entries(BUILTIN_NORN_LIBRARY_SOURCES)) {
    const lib = readLibrary(source, `${name}.norn`, host, { name, manifests: NORN_CONNECTOR_EVENT_MANIFESTS });
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
