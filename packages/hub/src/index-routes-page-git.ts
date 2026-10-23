import { namedPageBody, PageControlError, PostgresPageRepository } from "@xmatrix/db";
import type { Context, Hono } from "hono";
import type { AuthUser } from "./auth";
import { requireAuth } from "./index-shared";
import { sessionCall, sessionPrincipal } from "./index-routes-pages";
import {
  buildPageHistory, commitFiles, commitParents, concatBytes, pagePaths, pktLine, readPack, writePack,
  type GitObject,
} from "./page-git";
import { appOrigin } from "./deployment-origins";
import { frontmatterTitle, isReservedFile, splitFrontmatter, unlinkPages } from "./page-okf";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { authorityFailure, runPrincipalOf } from "./run-principal";
import type { Env } from "./types";

/**
 * The page store over git's smart HTTP protocol (docs/design/pages-and-conversations.md
 * §5.4): `git clone https://<hub>/git/<space>.git` with an xMatrix token as the
 * password. Each reader clones only the pages they can read, as an Open
 * Knowledge Format bundle (page-okf.ts), and a push is an ordinary authorized
 * edit: every changed page becomes a revision by the pusher.
 */
function repository(env: Env): PostgresPageRepository {
  return new PostgresPageRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-page-git", statementTimeoutMs: 20_000,
    transactionTimeoutMs: 30_000, lockTimeoutMs: 2_000,
  }));
}

const ZERO = "0".repeat(40);
const MAIN = "refs/heads/main";
const decoder = new TextDecoder("utf-8", { fatal: true });

/** git sends the token as the Basic password; the Hub reads it as a bearer token. */
async function reader(c: Context<{ Bindings: Env }>): Promise<AuthUser> {
  const header = c.req.header("authorization") ?? "";
  const basic = /^Basic\s+(.+)$/iu.exec(header);
  let authorization = header;
  if (basic) {
    const decoded = atob(basic[1]!.trim());
    authorization = `Bearer ${decoded.slice(decoded.indexOf(":") + 1)}`;
  }
  return requireAuth(new Request(c.req.url, { headers: { authorization } }), c.env);
}

function spaceOf(c: Context<{ Bindings: Env }>): string {
  return c.req.param("space")!.replace(/\.git$/u, "");
}

async function history(env: Env, spaceId: string, authUser: AuthUser) {
  const view = await repository(env).gitView({ requestId: crypto.randomUUID(), spaceId,
    principal: runPrincipalOf(authUser) });
  const pages = `${appOrigin(env)}/app/${encodeURIComponent(spaceId)}/pages?page=`;
  return { view, ...(await buildPageHistory(view.pages, view.revisions, {
    heading: view.spaceName, resource: (pageId) => `${pages}${encodeURIComponent(pageId)}`,
  })) };
}

function unauthorized(): Response {
  return new Response("Sign in with an xMatrix token as the password\n", {
    status: 401, headers: { "www-authenticate": 'Basic realm="xMatrix pages"', "content-type": "text/plain" },
  });
}

function failure(c: Context<{ Bindings: Env }>, error: unknown): Response {
  if (error instanceof Error && error.name === "AuthFailure") return unauthorized();
  if (error instanceof PageControlError && error.status === 404) return new Response("Not found\n", { status: 404 });
  return authorityFailure(c, error);
}

function advertise(service: string, head: string | null, capabilities: string): Uint8Array<ArrayBuffer> {
  const refs = head
    ? [pktLine(`${head} ${service === "git-upload-pack" ? "HEAD" : MAIN}\0${capabilities}\n`),
      ...(service === "git-upload-pack" ? [pktLine(`${head} ${MAIN}\n`)] : [])]
    : [pktLine(`${ZERO} capabilities^{}\0${capabilities}\n`)];
  return concatBytes([pktLine(`# service=${service}\n`), pktLine(null), ...refs, pktLine(null)]);
}

/** The ref updates at the head of a receive-pack request, and where the pack starts. */
function readCommands(body: Uint8Array): { commands: Array<{ from: string; to: string; ref: string }>; pack: Uint8Array } {
  const commands: Array<{ from: string; to: string; ref: string }> = [];
  let at = 0;
  for (;;) {
    const length = Number.parseInt(new TextDecoder().decode(body.subarray(at, at + 4)), 16);
    if (!Number.isFinite(length)) throw new Error("malformed request");
    if (length === 0) { at += 4; break; }
    const line = new TextDecoder().decode(body.subarray(at + 4, at + length)).split("\0")[0]!.trim();
    const [from, to, ref] = line.split(" ");
    commands.push({ from: from!, to: to!, ref: ref! });
    at += length;
  }
  return { commands, pack: body.subarray(at) };
}

/**
 * A new page's name when its file does not open with one (a page is named by the heading
 * its document opens with): its frontmatter `title`, or its file name.
 */
function titleOf(frontmatter: string | null, path: string): string {
  return (frontmatterTitle(frontmatter) || path.split("/").at(-1)!.replace(/\.md$/u, "")).slice(0, 200);
}

class Refused extends Error {}

/**
 * Applies a pushed commit that fast-forwards the reader's history: changed
 * pages are edited as the pusher, new Markdown files become pages below the
 * page their directory belongs to. Removing or renaming a page happens in
 * xMatrix, not by a push. A page's frontmatter is xMatrix's to write, and
 * `index.md`/`log.md` are never pages, so a pushed OKF bundle reads as its
 * concepts: a directory no page owns becomes a page named after it, and
 * links between the pushed files become `page:<id>` references.
 */
async function applyPush(env: Env, spaceId: string, authUser: AuthUser, current: Awaited<ReturnType<typeof history>>,
  to: string, objects: Map<string, GitObject>): Promise<void> {
  const lookup = (sha: string) => objects.get(sha) ?? current.objects.get(sha);
  for (let commit = to; commit !== current.head;) {
    const parents = commitParents(commit, lookup);
    if (parents.length > 1) throw new Refused("merge commits are not accepted; rebase onto the pages");
    if (parents.length === 0) {
      if (current.head) throw new Refused("the push does not build on the pages; pull first");
      break;
    }
    commit = parents[0]!;
  }
  const concepts = (files: Map<string, Uint8Array>) => new Map([...files].filter(([path]) => !isReservedFile(path)));
  const before = concepts(current.head ? commitFiles(current.head, lookup) : new Map<string, Uint8Array>());
  const after = concepts(commitFiles(to, lookup));
  const paths = pagePaths(current.view.pages);
  const pageByFile = new Map([...paths].map(([pageId, place]) => [place.file, pageId]));
  const heads = new Map<string, number>();
  for (const revision of current.view.revisions) {
    heads.set(revision.pageId, Math.max(heads.get(revision.pageId) ?? 0, revision.revision));
  }
  const text = (path: string, bytes: Uint8Array) => {
    if (!path.endsWith(".md")) throw new Refused(`${path}: only Markdown pages can be pushed`);
    try { return decoder.decode(bytes); } catch { throw new Refused(`${path}: pages are UTF-8 text`); }
  };
  for (const path of before.keys()) {
    if (!after.has(path)) throw new Refused(`${path}: remove or move pages in xMatrix, not by a push`);
  }
  const edits: Array<{ pageId: string; path: string; body: string }> = [];
  const creations: Array<{ path: string; frontmatter: string | null; body: string }> = [];
  for (const [path, bytes] of after) {
    const previous = before.get(path);
    if (previous && previous.length === bytes.length && previous.every((byte, index) => byte === bytes[index])) continue;
    const pushed = splitFrontmatter(text(path, bytes));
    const pageId = pageByFile.get(path);
    if (pageId) {
      if (pushed.frontmatter !== (previous ? splitFrontmatter(text(path, previous)).frontmatter : null)) {
        throw new Refused(`${path}: xMatrix writes the frontmatter; rename pages in xMatrix and edit only the text`);
      }
      edits.push({ pageId, path, body: pushed.body });
    } else creations.push({ path, ...pushed });
  }
  const pages = repository(env);
  const principal = runPrincipalOf(authUser);
  // Parents before children: a directory belongs to the page `<dir>.md` beside it,
  // created first; a directory with no such page (a pushed bundle's group) becomes one.
  const created: Array<{ pageId: string; path: string; title: string; pushed: string; body: string;
    revision: number }> = [];
  const create = async (path: string, parentPageId: string | null, title: string, pushed: string) => {
    const body = namedPageBody(unlinkPages(pushed, path, pageByFile), title);
    const { page } = await pages.create({ requestId: crypto.randomUUID(), spaceId, principal, parentPageId, title, body });
    pageByFile.set(path, page.pageId);
    created.push({ pageId: page.pageId, path, title, pushed, body, revision: page.headRevision });
    return page.pageId;
  };
  const dirPage = async (dir: string): Promise<string | null> => {
    if (dir === "") return null;
    const file = `${dir.slice(0, -1)}.md`;
    const owner = pageByFile.get(file);
    if (owner) return owner;
    const name = dir.slice(0, -1).split("/").at(-1)!;
    return create(file, await dirPage(dir.slice(0, dir.slice(0, -1).lastIndexOf("/") + 1)), name, `# ${name}\n`);
  };
  const ordered = creations.sort((a, b) => a.path.split("/").length - b.path.split("/").length ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const creation of ordered) {
    if (pageByFile.has(creation.path)) throw new Refused(`${creation.path}: a page already has this file`);
    await create(creation.path, await dirPage(creation.path.slice(0, creation.path.lastIndexOf("/") + 1)),
      titleOf(creation.frontmatter, creation.path), creation.body);
  }
  // Links to pages created later in the push resolve once every page exists.
  for (const page of created) {
    const body = namedPageBody(unlinkPages(page.pushed, page.path, pageByFile), page.title);
    if (body === page.body) continue;
    const response = await sessionCall(env, spaceId, page.pageId, "/internal/edit", {
      principal: sessionPrincipal(authUser), baseRevision: page.revision, body, conversationIds: [],
    });
    if (!response.ok) {
      const refusal = await response.json().catch(() => ({})) as { error?: string };
      throw new Refused(`${page.path}: ${refusal.error ?? "edit refused"}`);
    }
  }
  // Edits last, so their links reach the pages this push created.
  for (const edit of edits) {
    const response = await sessionCall(env, spaceId, edit.pageId, "/internal/edit", {
      principal: sessionPrincipal(authUser), baseRevision: heads.get(edit.pageId),
      body: unlinkPages(edit.body, edit.path, pageByFile), conversationIds: [],
    });
    if (!response.ok) {
      const refusal = await response.json().catch(() => ({})) as { error?: string };
      throw new Refused(`${edit.path}: ${refusal.error ?? "edit refused"}`);
    }
  }
}

export function registerPageGitRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/git/:space/info/refs", async (c) => {
    const service = c.req.query("service");
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      return new Response("Use a git client\n", { status: 403 });
    }
    try {
      const { head } = await history(c.env, spaceOf(c), await reader(c));
      const capabilities = service === "git-upload-pack"
        ? "no-progress symref=HEAD:refs/heads/main agent=xmatrix"
        : "report-status agent=xmatrix";
      return new Response(advertise(service, head, capabilities), {
        headers: { "content-type": `application/x-${service}-advertisement`, "cache-control": "no-store" },
      });
    } catch (error) {
      return failure(c, error);
    }
  });

  // Every fetch receives the whole history: it is small, derived and deterministic,
  // so the client keeps what it already has and git needs no negotiation.
  app.post("/git/:space/git-upload-pack", async (c) => {
    try {
      const { objects } = await history(c.env, spaceOf(c), await reader(c));
      return new Response(concatBytes([pktLine("NAK\n"), await writePack(objects)]), {
        headers: { "content-type": "application/x-git-upload-pack-result", "cache-control": "no-store" },
      });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post("/git/:space/git-receive-pack", async (c) => {
    try {
      const spaceId = spaceOf(c);
      const authUser = await reader(c);
      const current = await history(c.env, spaceId, authUser);
      const { commands, pack } = readCommands(new Uint8Array(await c.req.arrayBuffer()));
      const report = async (): Promise<string> => {
        const command = commands[0];
        if (commands.length !== 1 || command?.ref !== MAIN) return "only refs/heads/main can be pushed";
        if (command.to === ZERO) return "the pages cannot be deleted";
        if (command.from !== (current.head ?? ZERO)) return "fetch first: the pages changed";
        try {
          await applyPush(c.env, spaceId, authUser, current, command.to, await readPack(pack, current.objects));
          return "";
        } catch (error) {
          if (error instanceof Refused) return error.message;
          if (error instanceof PageControlError) return error.message;
          throw error;
        }
      };
      const refusal = await report();
      const ref = commands[0]?.ref ?? MAIN;
      return new Response(concatBytes([
        pktLine("unpack ok\n"), pktLine(refusal ? `ng ${ref} ${refusal}\n` : `ok ${ref}\n`), pktLine(null),
      ]), { headers: { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-store" } });
    } catch (error) {
      return failure(c, error);
    }
  });
}
