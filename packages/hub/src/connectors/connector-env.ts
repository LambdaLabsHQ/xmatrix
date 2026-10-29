import type { Env } from "../types";

/** A trimmed connector setting. Missing or non-string values are empty. */
export function trimmedConnectorEnv(env: Env, name: string): string {
  const raw = (env as unknown as Record<string, unknown>)[name];
  return typeof raw === "string" ? raw.trim() : "";
}
