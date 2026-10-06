import { redirectInsecureRequest } from "./https-redirect";
/**
 * Test Worker entrypoint: the production Worker plus test-only fixture routes.
 */
import production from "./index";
import type { Env } from "./types";
import { syncHumanProfile } from "./human-profile-sync";

export * from "./index";

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
    const redirect = redirectInsecureRequest(request);
    if (redirect) return redirect;
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/__test/postgres-channel-coordinator-rpc") {
      const input = await request.json() as {
        channelId: string;
        commandId: string;
        observedPostgresHead: number;
      };
      const stub = env.RELAY_POSTGRES_CHANNEL_COORDINATOR.get(
        env.RELAY_POSTGRES_CHANNEL_COORDINATOR.idFromName(input.channelId),
      ) as unknown as {
        reserve(value: typeof input): Promise<{
          channelId: string;
          commandId: string;
          sequence: number;
          state: "reserved" | "committed";
        }>;
        status(value: { channelId: string }): Promise<{
          channelId: string;
          allocatedSequence: number;
          confirmedSequence: number;
          reservationCount: number;
        }>;
      };
      const reservation = await stub.reserve(input);
      return Response.json({ reservation, status: await stub.status({ channelId: input.channelId }) });
    }
    if (request.method === "POST" && url.pathname === "/__test/human-profile") {
      try {
        const value = await request.json() as Record<string, unknown>;
        const userId = typeof value.userId === "string" ? value.userId.trim() : "";
        const displayName = typeof value.displayName === "string" ? value.displayName.trim() : "";
        const handle = typeof value.handle === "string" ? value.handle.trim() : "";
        const profileVersion = Number(value.profileVersion);
        if (!userId || userId.length > 200 || !displayName || displayName.length > 200 ||
            !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(handle) ||
            !Number.isSafeInteger(profileVersion) || profileVersion < 1) {
          return Response.json({ code: "invalid_test_profile" }, { status: 400 });
        }
        const synced = await syncHumanProfile(env, {
          identityId: `user:${userId}`,
          userId,
          displayName,
          handle,
          profileVersion,
        }, new Date().toISOString());
        return Response.json({ synced }, { status: synced ? 200 : 503 });
      } catch (error) {
        return Response.json({ code: "test_profile_sync_failed", message: (error as Error).message }, {
          status: 400,
        });
      }
    }
    return production.fetch(request, env, executionCtx);
  },
  queue: production.queue,
} satisfies ExportedHandler<Env>;
