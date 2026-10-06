import { PageControlError, PostgresPageRepository } from "@xmatrix/db";
import type { Context, Hono } from "hono";
import type { AuthUser } from "./auth";
import { requireAuth } from "./index-shared";
import { sessionCall, sessionPrincipal } from "./index-routes-pages";
import {
  buildPageHistory, commitFiles, commitParents, concatBytes, pagePaths, pktLine, readPack, writePack,
  type GitObject,
} from "./page-git";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { authorityFailure, runPrincipalOf } from "./run-principal";
import type { Env } from "./types";

/**
 * The page store over git's smart HTTP protocol (docs/design/pages-and-conversations.md
 * §5.4): `git clone https://<hub>/git/<space>.git` with an xMatrix token as the
 * password. Each reader clones only the pages they can read, and a push is an
 * ordinary authorized edit: every changed page becomes a revision by the pusher.
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
  return { view, ...(await buildPageHistory(view.pages, view.revisions)) };
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

/** A new page's title: its first heading, or its file name. */
function titleOf(body: string, path: string): string {
  const heading = /^#\s+(.+)$/mu.exec(body)?.[1]?.trim();
  return (heading || path.split("/").at(-1)!.replace(/\.md$/u, "")).slice(0, 200);
}

class Refused extends Error {}

/**
 * Applies a pushed commit that fast-forwards the reader's history: changed
 * pages are edited as the pusher, new Markdown files become pages below the
 * page their directory belongs to. Removing or renaming a page happens in
 * xMatrix, not by a push.
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
  const before = current.head ? commitFiles(current.head, lookup) : new Map<string, Uint8Array>();
  const after = commitFiles(to, lookup);
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
  const edits: Array<{ pageId: string; body: string }> = [];
  const creations: Array<{ path: string; body: string }> = [];
  for (const [path, bytes] of after) {
    const previous = before.get(path);
    if (previous && previous.length === bytes.length && previous.every((byte, index) => byte === bytes[index])) continue;
    const body = text(path, bytes);
    const pageId = pageByFile.get(path);
    if (pageId) edits.push({ pageId, body });
    else creations.push({ path, body });
  }
  const pages = repository(env);
  const principal = runPrincipalOf(authUser);
  for (const edit of edits) {
    const response = await sessionCall(env, spaceId, edit.pageId, "/internal/edit", {
      principal: sessionPrincipal(authUser), baseRevision: heads.get(edit.pageId), body: edit.body, conversationIds: [],
    });
    if (!response.ok) {
      const refusal = await response.json().catch(() => ({})) as { error?: string };
      throw new Refused(`${[...pageByFile].find(([, id]) => id === edit.pageId)?.[0]}: ${refusal.error ?? "edit refused"}`);
    }
  }
  // Parents before children: a directory's README.md, then the files in it.
  const dirPage = (dir: string): string | null => {
    if (dir === "") return null;
    const pageId = pageByFile.get(`${dir}README.md`) ?? pageByFile.get(`${dir.slice(0, -1)}.md`);
    if (!pageId) throw new Refused(`${dir}: no page owns this directory`);
    return pageId;
  };
  const ordered = creations.sort((a, b) => a.path.split("/").length - b.path.split("/").length ||
    Number(b.path.endsWith("/README.md")) - Number(a.path.endsWith("/README.md")));
  for (const creation of ordered) {
    const segments = creation.path.split("/");
    const readme = segments.at(-1) === "README.md" && segments.length > 1;
    const parentDir = segments.slice(0, readme ? -2 : -1).join("/");
    const { page } = await pages.create({ requestId: crypto.randomUUID(), spaceId, principal,
      parentPageId: dirPage(parentDir ? `${parentDir}/` : ""), title: titleOf(creation.body, creation.path),
      body: creation.body });
    pageByFile.set(creation.path, page.pageId);
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
