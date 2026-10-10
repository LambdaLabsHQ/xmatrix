import type { Page } from "@playwright/test";

/**
 * In-page API fixtures.
 *
 * `page.route` handlers run in the *test runner's* Node process, so every
 * stubbed response has to wait for that process to be scheduled. Under a loaded
 * host — several worktrees running their own suites at once — a fulfil that
 * should cost a millisecond was measured at 2.9s, and the channel-scoped wave
 * never landed inside the 10s assertion budget at all. The app then rendered
 * "no channels" and every content assertion failed, which read as flakiness but
 * was really the fixtures never arriving.
 *
 * These fixtures are synthesised inside the browser instead. A response costs
 * one `new Response(...)` on the page's own main thread, so how fast a spec
 * gets its data no longer depends on how busy the machine is, or on how many
 * other suites share it.
 *
 * Semantics deliberately mirror `page.route` so specs port across unchanged:
 * patterns are Playwright globs or regular expressions matched against the full
 * URL, and the most recently registered rule wins. Rules are seeded as init
 * scripts, so they are reinstalled on every navigation in registration order.
 */

export type FixtureResponder =
  | { kind: "static"; status?: number; json: unknown; delayMs?: number; echoRequestId?: boolean }
  /**
   * Keyset history: `beforeSequence` is exclusive, newest page first.
   *
   * `sparse-head` covers the server that returns a short first page and says
   * `hasMore` anyway — the case that proves the client follows the server's
   * continuation cursor instead of counting rows.
   */
  | {
      kind: "pagedHistory";
      messages: ReadonlyArray<{ sequence: number }>;
      mode?: "keyset" | "sparse-head";
      firstPage?: ReadonlyArray<{ sequence: number }>;
    }
  /** Versioned preference document with optimistic-concurrency PATCH. */
  | {
      kind: "channelViewPreference";
      preference: Record<string, unknown>;
      /** Reject a patch whose `expectedVersion` is stale. On by default. */
      enforceVersion?: boolean;
    }
  /**
   * The Channel's authorized launch targets. The Channel and Profiles come from
   * the request, because the client rejects an answer about another Channel.
   */
  | {
      kind: "launchTargets";
      repos: ReadonlyArray<{ value: string; private?: boolean }>;
      repoStatus?: "authorized" | "not-connected" | "unavailable";
      repoStatusDetail?: string;
      workspaces: ReadonlyArray<Record<string, unknown>>;
    }
  /** Server-paged Channel catalog plus exact resolution, backed by one fixture list. */
  | {
      kind: "channelCatalog";
      channels: ReadonlyArray<Record<string, unknown>>;
      /** Answer only once the spec calls `releaseFixture(page, id)`, as `deferred` does. */
      held?: boolean;
    }
  /** One response per call, clamped to the last entry once exhausted. */
  | { kind: "sequence"; responses: ReadonlyArray<{ status?: number; json: unknown }> }
  /** Mirror the Hub-selected scoped upload path from an upload-intent body. */
  | { kind: "relayV2UploadIntent" }
  /**
   * A response the spec releases by hand, for the loading states that only
   * exist while a request is still outstanding. Release it with
   * `releaseFixture(page, id)`.
   */
  | { kind: "deferred"; status?: number; json: unknown };

export type FixtureRule = {
  /** Stable id so a spec can read back the requests this rule served. */
  id: string;
  /** Playwright glob, or a RegExp matched against the full URL. */
  pattern: string | RegExp;
  method?: string;
  responder: FixtureResponder;
};

const STORE_KEY = "__XMATRIX_E2E_API__";
const LOG_STORAGE_KEY = "xmatrix-e2e-api-log";

/**
 * Playwright glob semantics: `**` crosses path separators, `*` does not, `?` is
 * a single character. Everything else is literal.
 */
export function globToRegExpSource(glob: string): string {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += ".";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return `^${source}$`;
}

function ruleSource(pattern: string | RegExp): string {
  return pattern instanceof RegExp ? pattern.source : globToRegExpSource(pattern);
}

type SerializedRule = {
  id: string;
  source: string;
  method?: string;
  responder: FixtureResponder;
};

/**
 * Install the interceptor. Safe to call more than once per page; only the first
 * call takes effect, so a helper that composes other helpers cannot double-wrap
 * `fetch`.
 */
export async function installApiFixtures(page: Page): Promise<void> {
  await page.addInitScript(installInterceptor, {
    storeKey: STORE_KEY,
    logStorageKey: LOG_STORAGE_KEY,
  });
  // Same reason as `fixtureRule`: a page may already be open.
  await page
    .evaluate(installInterceptor, { storeKey: STORE_KEY, logStorageKey: LOG_STORAGE_KEY })
    .catch(() => undefined);
}

function installInterceptor({
  storeKey,
  logStorageKey,
}: {
  storeKey: string;
  logStorageKey: string;
}) {
  {
      const scope = window as unknown as Record<string, unknown>;
      if (scope[storeKey]) return;

      type Rule = {
        id: string;
        source: string;
        method?: string;
        responder: Record<string, unknown> & { kind: string };
      };
      type Gate = { promise: Promise<void>; release: () => void; released: boolean };
      type Store = {
        rules: Rule[];
        state: Record<string, unknown>;
        log: Array<{ id: string; method: string; url: string; body: string | null }>;
        gates: Record<string, Gate>;
        gateFor: (id: string) => Gate;
      };

      /* The log outlives navigations: a spec sets its fixtures up, the helper
         navigates, and only then does the spec assert on what was requested. */
      let restored: Store["log"] = [];
      try {
        restored = JSON.parse(sessionStorage.getItem(logStorageKey) || "[]");
      } catch {
        restored = [];
      }

      const store: Store = {
        rules: [],
        state: {},
        log: restored,
        gates: {},
        gateFor(id: string) {
          let gate = store.gates[id];
          if (!gate) {
            let release = () => undefined as void;
            const promise = new Promise<void>((resolve) => {
              release = resolve;
            });
            gate = { promise, release, released: false };
            store.gates[id] = gate;
          }
          return gate;
        },
      };
      scope[storeKey] = store;

      function persistLog() {
        try {
          sessionStorage.setItem(logStorageKey, JSON.stringify(store.log));
        } catch {
          // A full or unavailable sessionStorage must not fail the request.
        }
      }

      function jsonResponse(body: unknown, status: number) {
        return new Response(JSON.stringify(body ?? null), {
          status,
          headers: { "content-type": "application/json" },
        });
      }

      function pagedHistory(rule: Rule, url: URL) {
        const messages = (rule.responder.messages || []) as Array<{ sequence: number }>;
        const limit = Number(url.searchParams.get("limit") || 10);
        const beforeValue = url.searchParams.get("beforeSequence");
        const beforeSequence = beforeValue === null ? null : Number(beforeValue);

        if (rule.responder.mode === "sparse-head") {
          const firstPage = (rule.responder.firstPage || []) as Array<{ sequence: number }>;
          if (beforeSequence === null) {
            return jsonResponse({ messages: firstPage, hasMore: true }, 200);
          }
          return jsonResponse(
            {
              messages: messages.filter((message) => message.sequence < beforeSequence),
              hasMore: false,
            },
            200
          );
        }

        const eligible =
          beforeSequence === null
            ? messages
            : messages.filter((message) => message.sequence < beforeSequence);
        return jsonResponse(
          { messages: eligible.slice(-limit), hasMore: eligible.length > limit },
          200
        );
      }

      function launchTargets(rule: Rule, url: URL) {
        const segments = url.pathname.split("/").filter(Boolean);
        const spaceId = segments[segments.indexOf("spaces") + 1] || "";
        const repos = (rule.responder.repos as Array<Record<string, unknown>>) || [];
        return jsonResponse({
          spaceId: decodeURIComponent(spaceId),
          repos: repos.map((repo) => ({ value: repo.value, private: repo.private === true })),
          repoStatus: rule.responder.repoStatus || "authorized",
          ...(rule.responder.repoStatusDetail
            ? { repoStatusDetail: rule.responder.repoStatusDetail }
            : {}),
          workspaces: rule.responder.workspaces || [],
        }, 200);
      }

      async function channelViewPreference(rule: Rule, method: string, body: string | null) {
        const state = (store.state[rule.id] ||= JSON.parse(
          JSON.stringify(rule.responder.preference)
        )) as Record<string, unknown> & { version: number };
        if (method === "PATCH") {
          let patch: Record<string, unknown> = {};
          try {
            patch = body ? JSON.parse(body) : {};
          } catch {
            patch = {};
          }
          if (
            rule.responder.enforceVersion !== false &&
            patch.expectedVersion !== state.version
          ) {
            return jsonResponse({ error: "stale preference" }, 409);
          }
          if (patch.childViews && typeof patch.childViews === "object") {
            state.childViews = patch.childViews;
          }
          /* `[]` is a real write (unpin the last pin). Only `undefined` means
             leave the stored list alone, matching Core's omitted-field
             contract. */
          if (Array.isArray(patch.pinnedChannelIds)) {
            state.pinnedChannelIds = patch.pinnedChannelIds.filter(
              (id: unknown): id is string => typeof id === "string" && id.length > 0
            );
          }
          if (typeof patch.followUpReviewSchedule === "string") {
            state.followUpReviewSchedule = patch.followUpReviewSchedule;
          }
          state.version += 1;
        }
        return jsonResponse(state, 200);
      }

      function channelCatalog(rule: Rule, url: URL, method: string, body: string | null) {
        type Channel = Record<string, unknown> & {
          id: string;
          name?: string;
          updatedAt?: string;
          metadata?: Record<string, unknown>;
          lastMessage?: { sentAt?: string };
          attention?: { unreadAttentionCount?: number; primaryTriggerKind?: string };
        };
        const channels = (rule.responder.channels || []) as Channel[];
        const byId = new Map(channels.map((channel) => [channel.id, channel]));
        const activity = (channel: Channel) =>
          channel.lastMessage?.sentAt || channel.updatedAt || "1970-01-01T00:00:00.000Z";
        const attentionCount = (channel: Channel) =>
          Number(channel.attention?.unreadAttentionCount || 0);
        const matchesFilter = (channel: Channel, filter: string) =>
          filter === "all" || attentionCount(channel) > 0;

        if (method === "POST" || url.pathname.endsWith("/resolve")) {
          let request: { channelIds?: unknown } = {};
          try {
            request = body ? JSON.parse(body) : {};
          } catch {
            request = {};
          }
          const requested = Array.isArray(request.channelIds)
            ? request.channelIds.filter((id): id is string => typeof id === "string")
            : [];
          const pathsByChannelId: Record<string, string[]> = {};
          const selected = new Set<string>();
          for (const channelId of requested) {
            if (!byId.has(channelId)) continue;
            pathsByChannelId[channelId] = [channelId];
            selected.add(channelId);
          }
          return jsonResponse({
            protocolVersion: 1,
            channels: channels.filter((channel) => selected.has(channel.id)),
            pathsByChannelId,
          }, 200);
        }

        // The Hub lists every readable conversation flat, archived or not.
        const view = url.searchParams.get("view") || "flat";
        const filter = url.searchParams.get("filter") || "all";
        const query = (url.searchParams.get("query") || "").toLocaleLowerCase();
        let candidates = channels.filter((channel) => {
          // An open project's intake is its own list, as the Hub keeps it.
          const intake = typeof channel.metadata?.intakeOf === "string";
          if (view === "intake") return intake && matchesFilter(channel, filter);
          if (view === "search") {
            return String(channel.name || "").toLocaleLowerCase().includes(query);
          }
          return !intake && matchesFilter(channel, filter);
        });
        candidates = candidates.sort((left, right) =>
          activity(right).localeCompare(activity(left)) || left.id.localeCompare(right.id)
        );
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 50);
        const offset = Math.max(Number(url.searchParams.get("cursor") || 0), 0);
        const page = candidates.slice(offset, offset + limit);
        const active = channels;
        return jsonResponse({
          protocolVersion: 1,
          catalogRevision: 1,
          rows: page.map((channel) => ({
            channel,
            ownActivityAt: activity(channel),
          })),
          nextCursor: offset + limit < candidates.length ? String(offset + limit) : null,
          counts: {
            active: active.length,
            unread: active.filter((channel) => attentionCount(channel) > 0).length,
            mentions: active.filter((channel) => attentionCount(channel) > 0).length,
          },
        }, 200);
      }

      function sequence(rule: Rule) {
        const responses = (rule.responder.responses || []) as Array<{
          status?: number;
          json: unknown;
        }>;
        const index = (store.state[rule.id] as number) ?? 0;
        store.state[rule.id] = index + 1;
        const picked = responses[Math.min(index, responses.length - 1)];
        return jsonResponse(picked?.json ?? {}, picked?.status ?? 200);
      }

      function relayV2UploadIntent(body: string | null) {
        let intent: Record<string, unknown> = {};
        try {
          intent = body ? JSON.parse(body) as Record<string, unknown> : {};
        } catch {
          return jsonResponse({ error: "invalid upload intent" }, 400);
        }
        const intentId = typeof intent.intentId === "string" ? intent.intentId : "";
        const visibilityScopeId = typeof intent.visibilityScopeId === "string"
          ? intent.visibilityScopeId
          : "";
        if (!intentId || !visibilityScopeId) {
          return jsonResponse({ error: "invalid upload intent" }, 400);
        }
        const root = `/api/relay-v2/private-r2/uploads/${encodeURIComponent(intentId)}`;
        const scope = `/scope/${encodeURIComponent(visibilityScopeId)}`;
        return jsonResponse({
          ...intent,
          upload: {
            finalPath: `${root}${scope}`,
            stagingPath: `${root}/staging${scope}`,
            verifyPath: `${root}/verify${scope}`,
            checksumHeader: "x-xmatrix-content-sha256",
          },
        }, 200);
      }

      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : null;
        const rawUrl = request ? request.url : String(input);
        const method = String(
          init?.method || request?.method || "GET"
        ).toUpperCase();

        let url: URL;
        try {
          url = new URL(rawUrl, window.location.href);
        } catch {
          return originalFetch(input as RequestInfo, init);
        }

        for (let index = store.rules.length - 1; index >= 0; index -= 1) {
          const rule = store.rules[index];
          if (rule.method && rule.method.toUpperCase() !== method) continue;
          if (!new RegExp(rule.source).test(url.href)) continue;

          /* Read the body before responding: specs assert on what the app sent
             (a thread-create payload, a preference patch), which the old Node
             handlers captured through a callback. */
          let body: string | null = null;
          if (init?.body != null) body = String(init.body);
          else if (request) body = await request.clone().text().catch(() => null);

          store.log.push({ id: rule.id, method, url: url.href, body });
          persistLog();

          if (rule.responder.kind === "pagedHistory") return pagedHistory(rule, url);
          if (rule.responder.kind === "sequence") return sequence(rule);
          if (rule.responder.kind === "relayV2UploadIntent") {
            return relayV2UploadIntent(body);
          }
          if (rule.responder.kind === "deferred") {
            const gate = store.gateFor(rule.id);
            if (!gate.released) await gate.promise;
            return jsonResponse(
              rule.responder.json,
              (rule.responder.status as number | undefined) ?? 200
            );
          }
          if (rule.responder.kind === "channelViewPreference") {
            return channelViewPreference(rule, method, body);
          }
          if (rule.responder.kind === "channelCatalog") {
            const gate = rule.responder.held === true ? store.gateFor(rule.id) : null;
            if (gate && !gate.released) await gate.promise;
            return channelCatalog(rule, url, method, body);
          }
          if (rule.responder.kind === "launchTargets") {
            return launchTargets(rule, url);
          }
          if (rule.responder.echoRequestId === true) {
            const requestId = method === "GET" ? url.searchParams.get("requestId") : (body ? JSON.parse(body).requestId : undefined);
            return jsonResponse({ ...(rule.responder.json as Record<string, unknown>), requestId },
              (rule.responder.status as number | undefined) ?? 200);
          }
          const delayMs = rule.responder.delayMs as number | undefined;
          if (delayMs) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          return jsonResponse(
            rule.responder.json,
            (rule.responder.status as number | undefined) ?? 200
          );
        }

        return originalFetch(input as RequestInfo, init);
      };

      /* Attachment uploads go out over XMLHttpRequest, not fetch, because they
         need upload progress events. Patching only `fetch` let those PUTs
         escape to the network, where they failed and the composer never
         reached "Ready". */
      const OriginalXhr = window.XMLHttpRequest;
      function matchRule(url: string, method: string): Rule | undefined {
        for (let index = store.rules.length - 1; index >= 0; index -= 1) {
          const rule = store.rules[index];
          if (rule.method && rule.method.toUpperCase() !== method) continue;
          if (new RegExp(rule.source).test(url)) return rule;
        }
        return undefined;
      }

      class PatchedXhr extends OriginalXhr {
        private xmMethod = "GET";
        private xmUrl = "";

        open(method: string, url: string | URL, ...rest: unknown[]) {
          this.xmMethod = String(method).toUpperCase();
          try {
            this.xmUrl = new URL(String(url), window.location.href).href;
          } catch {
            this.xmUrl = String(url);
          }
          // @ts-expect-error - forwarding the browser's own overload set.
          return super.open(method, url, ...rest);
        }

        send(body?: Document | XMLHttpRequestBodyInit | null) {
          const rule = matchRule(this.xmUrl, this.xmMethod);
          if (!rule) {
            super.send(body as XMLHttpRequestBodyInit | null);
            return;
          }
          const responder = rule.responder as Record<string, unknown>;
          const status = (responder.status as number | undefined) ?? 200;
          const text = JSON.stringify(responder.json ?? null);
          store.log.push({
            id: rule.id,
            method: this.xmMethod,
            url: this.xmUrl,
            body: typeof body === "string" ? body : null,
          });
          persistLog();

          const settle = () => {
            for (const [name, value] of [
              ["readyState", 4],
              ["status", status],
              ["statusText", status === 200 ? "OK" : String(status)],
              ["responseText", text],
              ["response", text],
              ["responseURL", this.xmUrl],
            ] as const) {
              Object.defineProperty(this, name, { configurable: true, value });
            }
            const total = 1;
            this.upload?.dispatchEvent(
              Object.assign(new ProgressEvent("progress", {
                lengthComputable: true,
                loaded: total,
                total,
              }))
            );
            this.dispatchEvent(new Event("readystatechange"));
            this.dispatchEvent(new ProgressEvent("load"));
            this.dispatchEvent(new ProgressEvent("loadend"));
          };
          // Asynchronous like a real request, so callers that attach handlers
          // after `send` still see the events.
          setTimeout(settle, 0);
        }
      }
      window.XMLHttpRequest = PatchedXhr as unknown as typeof XMLHttpRequest;
  }
}

/**
 * Register one rule. Later rules win, so a spec overrides a shared fixture by
 * registering after it — exactly as it would with `page.route`.
 */
export async function fixtureRule(page: Page, rule: FixtureRule): Promise<void> {
  const serialized: SerializedRule = {
    id: rule.id,
    source: ruleSource(rule.pattern),
    method: rule.method,
    responder: rule.responder,
  };
  await page.addInitScript(seedRule, { storeKey: STORE_KEY, entry: serialized });
  /* `addInitScript` only reaches documents that have not loaded yet, but
     `page.route` — which these rules replace — also applies to the document
     already on screen. Specs rely on that: they open the workspace, then stub
     the endpoint an interaction is about to hit, without navigating again. */
  await page
    .evaluate(seedRule, { storeKey: STORE_KEY, entry: serialized })
    .catch(() => undefined);
}

function seedRule({ storeKey, entry }: { storeKey: string; entry: SerializedRule }) {
  const store = (window as unknown as Record<string, { rules: unknown[] } | undefined>)[storeKey];
  store?.rules.push(entry);
}

/**
 * Let a `deferred` rule answer. Safe to call before the request arrives: the
 * gate records the release, so a request that starts later is not held.
 */
export async function releaseFixture(page: Page, id: string): Promise<void> {
  await page.evaluate(
    ({ storeKey, ruleId }) => {
      const store = (window as unknown as Record<string, {
        gateFor: (value: string) => { release: () => void; released: boolean };
      } | undefined>)[storeKey];
      const gate = store?.gateFor(ruleId);
      if (!gate) return;
      gate.released = true;
      gate.release();
    },
    { storeKey: STORE_KEY, ruleId: id }
  );
}

/** Shorthand for the common "always answer with this JSON" rule. */
export async function fixtureJson(
  page: Page,
  id: string,
  pattern: string | RegExp,
  json: unknown,
  options: { status?: number; method?: string; delayMs?: number; echoRequestId?: boolean } = {}
): Promise<void> {
  await fixtureRule(page, {
    id,
    pattern,
    method: options.method,
    responder: { kind: "static", status: options.status, json, delayMs: options.delayMs, echoRequestId: options.echoRequestId },
  });
}

/** Stub both paged catalog reads and exact channel resolution. */
export async function fixtureChannelCatalog(
  page: Page,
  id: string,
  channels: ReadonlyArray<Record<string, unknown>>
): Promise<void> {
  await fixtureRule(page, {
    id,
    pattern: /\/api\/xmatrix\/channels\/(?:page|resolve)(?:\?.*)?$/,
    responder: { kind: "channelCatalog", channels },
  });
}

export type FixtureRequestRecord = { method: string; url: string; body: string | null };

/** Every request a rule served, in order, for specs that assert on traffic. */
export async function fixtureRequestRecords(
  page: Page,
  id: string
): Promise<FixtureRequestRecord[]> {
  return page.evaluate(
    ({ storeKey, ruleId }) => {
      const store = (window as unknown as Record<string, {
        log: Array<{ id: string; method: string; url: string; body: string | null }>;
      }>)[storeKey];
      return (store?.log || [])
        .filter((entry) => entry.id === ruleId)
        .map((entry) => ({ method: entry.method, url: entry.url, body: entry.body }));
    },
    { storeKey: STORE_KEY, ruleId: id }
  );
}

export async function fixtureRequests(page: Page, id: string): Promise<string[]> {
  return (await fixtureRequestRecords(page, id)).map((entry) => entry.url);
}

/** Parsed JSON bodies a rule received, for specs that assert on what was sent. */
export async function fixtureRequestBodies(
  page: Page,
  id: string
): Promise<Array<Record<string, unknown>>> {
  const records = await fixtureRequestRecords(page, id);
  return records.flatMap((record) => {
    if (!record.body) return [];
    try {
      return [JSON.parse(record.body) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

/**
 * The `beforeSequence` cursors a keyset-history rule was asked for, in order.
 * `null` is the first page, which carries no cursor.
 */
export async function requestedBeforeSequences(
  page: Page,
  id: string
): Promise<Array<number | null>> {
  const urls = await fixtureRequests(page, id);
  return urls.map((url) => {
    const value = new URL(url).searchParams.get("beforeSequence");
    return value === null ? null : Number(value);
  });
}
