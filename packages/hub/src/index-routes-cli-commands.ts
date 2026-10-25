import type { Hono } from "hono";
import type { Env } from "./types";
import { requireAuth, requestErrorResponse } from "./index-shared";
import { CliRouteError, commandsListing, runCliCommand, type CliCommand } from "./cli-commands";
import { AUTOMATION_COMMANDS, AUTOMATION_GROUP } from "./cli-commands-automation";

const COMMANDS: CliCommand[] = [
  {
    path: ["commands"], about: "List the commands the Hub defines",
    run: async () => ({ stdout: commandsListing(COMMANDS, GROUPS) }),
  },
  ...AUTOMATION_COMMANDS,
];
const GROUPS: Record<string, string> = { ...AUTOMATION_GROUP };

const MAX_ARGV = 64;
const MAX_WORD = 16 * 1024;

/** `POST /api/cli/commands/run` `{ argv }` → `{ stdout, stderr?, exitCode }`, or `{ unknownCommand: true }`. */
export function registerCliCommandRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post("/api/cli/commands/run", async (c) => {
    try {
      await requireAuth(c.req.raw, c.env);
      const body = await c.req.json().catch(() => null) as { argv?: unknown } | null;
      const argv = body?.argv;
      if (!Array.isArray(argv) || !argv.length || argv.length > MAX_ARGV ||
          !argv.every((word) => typeof word === "string" && word.length <= MAX_WORD)) {
        return c.json({ error: "argv must be 1 to 64 strings", code: "invalid_request" }, 400);
      }
      const call = async (method: string, route: string, payload?: unknown) => {
        // The caller's own headers (credential, client version, cell), as if it had called the route itself.
        const headers = new Headers(c.req.raw.headers);
        headers.delete("content-length");
        if (payload === undefined) headers.delete("content-type");
        else headers.set("content-type", "application/json");
        const response = await app.fetch(new Request(new URL(route, c.req.url), {
          method,
          headers,
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        }), c.env, c.executionCtx);
        const text = await response.text();
        let parsed: unknown = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* plain text */ }
        if (!response.ok) {
          const message = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
            ? (parsed as { error: string }).error : text || `HTTP ${response.status}`;
          throw new CliRouteError(response.status, `${message} (HTTP ${response.status})`);
        }
        return parsed;
      };
      const output = await runCliCommand(COMMANDS, GROUPS, argv as string[], call);
      // Not a refusal: the CLI then reports the word as it reports any unknown command.
      if (!output) return c.json({ unknownCommand: true }, 200, { "cache-control": "private, no-store" });
      return c.json({ stdout: output.stdout, ...(output.stderr ? { stderr: output.stderr } : {}),
        exitCode: output.exitCode ?? 0 }, 200, { "cache-control": "private, no-store" });
    } catch (error) {
      return requestErrorResponse(c, error);
    }
  });
}
