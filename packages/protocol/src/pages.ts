/** Wire types of the page authority (docs/design/pages-and-conversations.md). */

import type { LiveAgentStatus } from "./authority-foundation.js";
import type { MessageSender } from "./authority-runtime.js";
import { externalAppSource, type ExternalAppSource } from "./external-app-source.js";

export interface PageSummary {
  pageId: string;
  parentPageId: string | null;
  title: string;
  position: string;
  accessMode: "open" | "restricted";
  headRevision: number;
  agentSuggestOnly: boolean;
  canEdit: boolean;
  updatedAt: string;
  /** When a Space owner or admin published it for anyone to read; null when not public. */
  publishedAt: string | null;
  /** The page that states how the Space is run (docs/design/open-project-governance.md §4). */
  governance: boolean;
  /**
   * One line saying how the page stands, and the revision it was written for.
   * It describes the page as it is only while `revision` is `headRevision`.
   */
  summary?: { text: string; revision: number; at: string } | null;
  /** In the tree: the newest revision this reader has had on screen; null before they first open the page, or for a Run. */
  readRevision?: number | null;
}

export interface PageAuthor {
  kind: "user" | "agent"; id: string; label: string; ownerUserId?: string;
  /** Optional attribution supplied by Hub; identity and access still belong to the person. */
  application?: ExternalAppSource;
}

export function pageAuthorLabel(author: Pick<PageAuthor, "label" | "application">): string {
  const application = externalAppSource(author.application);
  return author.label + (application ? ` via ${application.name}` : "");
}

/**
 * Muted inks that sit on the page's paper: terracotta, green, slate blue, plum, rose, olive and umber. Each carries
 * white text at 4.5:1 or more, as an Agent's pill needs, and none is yellow, which is the comments' colour.
 */
const PAGE_AUTHOR_COLORS = ["#b85a3b", "#2f6f5e", "#4b6382", "#7a5389", "#a54960", "#5c6a2e", "#8a5a2b"];

/**
 * One colour per person or Agent wherever a page shows them: their caret,
 * the ring on their avatar, their pill, and their changes in History.
 */
export function pageAuthorColor(author: { kind: "user" | "agent"; id: string }): string {
  let hash = 0;
  for (const char of `${author.kind}:${author.id}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PAGE_AUTHOR_COLORS[hash % PAGE_AUTHOR_COLORS.length]!;
}

export interface PageRevision {
  revision: number;
  kind: "edit" | "suggestion" | "accepted" | "restore" | "purge";
  authors: PageAuthor[];
  conversationIds: string[];
  basedOnRevision: number | null;
  createdAt: string;
}

/** An Automation a page edit detached or attached (docs/design/pages-live-document.md §6.1). */
export interface PageAutomationAnchorChange { automationId: string; name: string }

/**
 * A whole-document page edit as committed, and what it did besides its text:
 * the Automations whose reference it removed (now paused) or brought back
 * (resumed), and the top sections it removed. The writer is told at once, as
 * an edit that drops sections is otherwise silent.
 */
export interface PageEditResult {
  revision: number;
  kind: PageRevision["kind"];
  headRevision: number;
  detachedAutomations: PageAutomationAnchorChange[];
  attachedAutomations: PageAutomationAnchorChange[];
  /** Titles of the depth 1 and 2 headings the edit removed or renamed. */
  removedSections: string[];
}

/**
 * What anyone reading a section should know besides its text
 * (docs/design/pages-live-document.md §3): when and where it last changed,
 * and who is on it now. Derived from revisions, links and the page's live
 * session; never stored.
 */
export interface PageBlockAwareness {
  /** Heading slug, or '' for the text before the first heading. */
  blockId: string;
  /** The latest revision that changed this section, when it is in recent history. */
  updated: Pick<PageRevision, "revision" | "authors" | "conversationIds" | "createdAt"> | null;
  present: PagePresent[];
  /** Open discussions anchored in this section. */
  discussions: Array<{ linkId: string; conversationId: string; quote: string }>;
  /**
   * Agents live in a conversation linked to this section, whether or not they
   * have the page open (docs/design/pages-live-document.md §3.2).
   */
  working?: PageWorkingAgent[];
}

/**
 * An Agent on a page now, for the page tree: live in a conversation whose
 * current Run read or edited the page, as a Channel row shows its live Agents.
 */
export interface PageTreeAgent {
  instanceId: string;
  name: string;
  /** Live Instance status — same set as `isLiveAgentStatus`, not a second enum. */
  status: LiveAgentStatus;
  /** The harness its Run was registered with, which gives its face (faces.ts). */
  harness?: string;
  conversationId: string;
  /** What its Run last did on the page. */
  activity: "viewing" | "editing";
  /** The section it last read or edited; empty is the whole page. */
  blockId: string;
  /** That section's heading, while the page still has it. */
  section?: string;
}

/**
 * A page in the tree: who is on it now, and its open discussions (their
 * outcome not yet written into the page) as this reader sees them.
 */
export interface PageTreeActivity {
  pageId: string;
  agents: PageTreeAgent[];
  discussions: {
    open: number;
    /** Open discussions with messages this reader has not read, among those they have opened. */
    unread: number;
    /** The newest message in any of them. */
    latest: PageConversation["lastMessage"];
  };
}

/** An Agent live in a conversation linked to a section: `busy` is working on a turn. */
export interface PageWorkingAgent {
  name: string;
  status: LiveAgentStatus;
  conversationId: string;
}

/**
 * A conversation linked to a page, as its reader sees it beside the page
 * (docs/design/pages-live-document.md §4.4): derived from the conversation
 * for this reader, never stored with the link.
 */
export interface PageConversation {
  conversationId: string;
  name: string | null;
  /** When anything last happened in it. */
  activityAt: string;
  /** Its newest message sequence, and how far this reader has read. */
  headSequence: number;
  readSequence: number;
  lastMessage: {
    /**
     * Who wrote it, as its message names them, for `faceOfSender` (faces.ts): a person and an Agent are drawn by
     * these ids. `avatarUrl` is the one the message carried, the face only of an author no account stands behind.
     */
    from: Pick<MessageSender, "kind" | "label" | "userId" | "identityId" | "instanceId" | "registration" | "avatarUrl">;
    bodyPreview: string;
    sentAt: string;
  } | null;
  /** Agents live in it now. */
  agents: Array<{ instanceId: string; name: string; status: LiveAgentStatus; harness?: string }>;
}

/** Someone on the page right now, and the section they are in. */
export interface PagePresent {
  name: string;
  kind: "user" | "agent";
  activity: string | null;
  blockId: string | null;
  /** The conversation an Agent works from. */
  conversationId: string | null;
}

/** What changed on a page since a revision someone read. */
/**
 * A page's latest change, as the Pages list shows it under Recent changes:
 * derived from its last two revisions, never stored.
 */
export interface PageRecentChange {
  pageId: string;
  title: string;
  revision: number;
  createdAt: string;
  authors: PageAuthor[];
  /** The section the change is in; null before the first heading. */
  block: { id: string; title: string } | null;
  /** The first text the change added, without markdown; null when it only removed text or made the page. */
  gist: string | null;
  /** The page's first revision: it was made, not changed. */
  created: boolean;
}

export interface PageChanges {
  pageId: string;
  since: number;
  headRevision: number;
  /** The revisions after `since`, oldest first. */
  revisions: PageRevision[];
  diff: Array<{ kind: "same" | "removed" | "added"; lines: string[] }>;
}

/**
 * Who wrote each piece of a page's newest revision (pages-live-document.md §3, Facts; page-blame.ts): `runs`
 * are `[length, revision, …]` over `body`, and `revisions` says who wrote each revision they name, from
 * which conversations, and when. `conversations` names those of them the reader can read.
 */
export interface PageBlame {
  pageId: string;
  revision: number;
  body: string;
  runs: number[];
  revisions: PageRevision[];
  conversations: Array<{ conversationId: string; name: string }>;
}

/** The message a revision's conversation was at when the revision was written, to open it there. */
export interface PageRevisionMoment {
  conversationId: string;
  messageId: string;
  sequence: number;
}

export interface PageAwareness {
  pageId: string;
  headRevision: number;
  blocks: PageBlockAwareness[];
}

/**
 * What an Agent's message changed on a page: the revisions its Instance committed from the message's conversation
 * since its previous message there, oldest first. Shown with the message, as a tool call shows what it did.
 */
export interface PageMessageEdit {
  messageId: string;
  pageId: string;
  title: string;
  revisions: Array<{ revision: number; basedOnRevision: number | null }>;
}

export interface PageDocument extends PageSummary {
  body: string;
  revisionInfo: PageRevision;
}

/**
 * A GitHub file a page embeds (`xmatrix:github-file/…`), as the Hub read it
 * through the Space's GitHub connection a moment ago; never stored.
 */
export interface PageGitHubFile {
  /** `owner/repo`. */
  repository: string;
  path: string;
  /** The ref the embed pins; null for the default branch. */
  ref: string | null;
  /** The blob GitHub served. */
  sha: string;
  size: number;
  htmlUrl: string | null;
  /** The file as UTF-8 text, cut when `truncated`; null for a binary file or one too large for GitHub to inline. */
  text: string | null;
  truncated: boolean;
}

/** One page whose title or current text contains a Ctrl+F query. */
export interface PageSearchHit {
  pageId: string;
  title: string;
  /** Heading slug of the section that matched, or '' for the title or the text before the first heading. */
  blockId: string;
  blockTitle: string;
  field: "title" | "body";
  snippet: string;
}

/** A published page as anyone reads it, signed in or not, at /p/<space>/<page>. */
export interface PublicPage {
  spaceId: string;
  spaceName: string;
  pageId: string;
  title: string;
  body: string;
  headRevision: number;
  updatedAt: string;
  /** Who wrote the current revision: people and Agents, by name. */
  authors: Array<{ kind: "user" | "agent"; label: string }>;
  /** Published pages directly below it. */
  children: Array<{ pageId: string; title: string }>;
  /** Whether anyone with a linked GitHub account may join the project (open-project-governance.md §1). */
  openToJoin: boolean;
}

export interface PageLink {
  linkId: string;
  conversationId: string;
  pageId: string;
  blockId: string;
  source: "jev" | "read" | "edit" | "reference" | "manual" | "migration";
  createdAt: string;
  lastSeenAt: string;
  /** A discussion's text: the conversation is about this range of the page. */
  anchor?: PageLinkAnchor | null;
  /** Set once the discussion's outcome is written into the page. */
  resolvedAt?: string | null;
}

/**
 * Where a discussion sits in the page (docs/design/pages-live-document.md
 * §4.3): Yjs relative positions in the live document, so the anchor follows
 * edits, and the quoted text for anyone reading without the document.
 */
export interface PageLinkAnchor {
  quote: string;
  from: unknown;
  to: unknown;
}

/**
 * A Space's move to pages (docs/design/pages-and-conversations-migration.md §3):
 * an Agent reads the Space and drafts a new page tree; a Space owner or admin
 * reviews it and applies it.
 */
export interface PageMigrationDraftPage {
  /** Stable within the draft; the applied page's id derives from it. */
  key: string;
  /** A page earlier in the draft, or null for a top-level page. */
  parentKey: string | null;
  title: string;
  body: string;
  /** Conversations the page was written from; they become its links. */
  sources: string[];
}

export interface PageMigrationDraft {
  pages: PageMigrationDraftPage[];
}

export interface PageMigrationReport {
  pages: number;
  links: number;
  restrictedPages: number;
}

export interface PageMigrationSource {
  conversationId: string;
  name: string;
  /** A closed conversation's page is readable only by readers of all its closed sources. */
  closed: boolean;
}

export interface PageMigration {
  spaceId: string;
  /** "none": nothing drafted yet. */
  state: "none" | "proposed" | "applied";
  /** 0 while nothing is drafted; a submission or revision names the version it replaces. */
  version: number;
  drafter: PageAuthor | null;
  draft: PageMigrationDraft;
  sources: PageMigrationSource[];
  report: PageMigrationReport | null;
  /** Who published it. */
  applied: PageMigrationApplied | null;
}

export interface PageMigrationApplied {
  by: PageAuthor;
}

/** The Yjs shared type a page's live document lives in, in the page session and every editor. */
export const PAGE_DOCUMENT_FRAGMENT = "prosemirror";
