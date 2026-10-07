/** Wire types of the page authority (docs/design/pages-and-conversations.md). */

import type { LiveAgentStatus } from "./authority-foundation.js";

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
}

export interface PageAuthor { kind: "user" | "agent"; id: string; label: string; ownerUserId?: string }

const PAGE_AUTHOR_COLORS = ["#2563eb", "#db2777", "#16a34a", "#ea580c", "#7c3aed", "#0891b2", "#ca8a04"];

/**
 * One colour per person or Agent wherever a page shows them: their caret,
 * the ring on their avatar, and their changes in History.
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

/**
 * What anyone reading a section should know besides its text
 * (docs/design/pages-live-document.md §3): when and where it last changed,
 * who has taken it, and who is on it now. Derived from revisions, claims and
 * the page's live session; never stored.
 */
export interface PageBlockAwareness {
  /** Heading slug, or '' for the text before the first heading. */
  blockId: string;
  /** The latest revision that changed this section, when it is in recent history. */
  updated: Pick<PageRevision, "revision" | "authors" | "conversationIds" | "createdAt"> | null;
  claims: PageClaim[];
  present: PagePresent[];
  /** Open discussions anchored in this section. */
  discussions: Array<{ linkId: string; conversationId: string; quote: string }>;
  /**
   * Agents live in a conversation linked to this section, whether or not they
   * have the page open (docs/design/pages-live-document.md §3.2).
   */
  working?: PageWorkingAgent[];
  /**
   * The section owes an update (docs/design/pages-live-document.md §5): work
   * claimed on it ended after its last change, and nobody wrote it back or
   * said nothing there changed.
   */
  owed: PageOwedUpdate | null;
}

export interface PageOwedUpdate {
  reason: "merged" | "released" | "lapsed";
  /** When the claimed work ended. */
  at: string;
  holder: string;
  conversationId: string | null;
  pullRequestUrl: string | null;
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
  avatarUrl?: string;
  conversationId: string;
  /** What its Run last did on the page. */
  activity: "viewing" | "editing";
  /** The section it last read or edited; empty is the whole page. */
  blockId: string;
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
    from: { kind: "user" | "agent" | "app" | "system"; label: string };
    bodyPreview: string;
    sentAt: string;
  } | null;
  /** Agents live in it now. */
  agents: Array<{ instanceId: string; name: string; status: LiveAgentStatus; avatarUrl?: string }>;
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

export interface PageAwareness {
  pageId: string;
  headRevision: number;
  blocks: PageBlockAwareness[];
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

/**
 * A claim: a lease on a page block,
 * shown next to it as "alice's claude:1 is on this". It lapses at expiresAt
 * unless its holder renews it.
 */
export interface PageClaim {
  claimId: string;
  pageId: string;
  /** The heading slug of the block; empty for the whole page. */
  blockId: string;
  holder: { kind: "user" | "agent"; id: string; label: string };
  /** The person it counts against: the human, or the Agent's owner. */
  ownerUserId: string;
  conversationId: string | null;
  /** The pull request doing the work, once the GitHub claim check has seen it. */
  pullRequestUrl: string | null;
  expiresAt: string;
  createdAt: string;
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
