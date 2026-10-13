import { canonicalRegistrationHarness } from "./agent-registration.js";

/** Enough for a paragraph or two; the bound keeps every profile inside one routing question. */
export const HARNESS_PROFILE_DESCRIPTION_LIMIT = 1_000;

/**
 * What a Space says a harness is for, in its members' own words: one free
 * text per Space and harness. Automatic routing reads it as background when
 * it judges how well the harness suits a piece of work. `revision` counts the
 * edits and is 0 while nothing was ever written.
 */
export interface SpaceHarnessProfile {
  description: string;
  revision: number;
}

export interface HarnessProfileCommand {
  harness: string;
  description: string;
  /** The revision the writer read; a profile edited since is not overwritten. */
  expectedRevision?: number;
}

/** Any text is a description. Only its length and NUL, which storage cannot hold, are refused. */
function parseHarnessProfileDescription(value: unknown): string {
  if (typeof value !== "string" || value.includes("\u0000")) throw new Error("Invalid harness description");
  const description = value.trim();
  if ([...description].length > HARNESS_PROFILE_DESCRIPTION_LIMIT) throw new Error("Harness description is too long");
  return description;
}

export function parseHarnessProfileCommand(value: unknown): HarnessProfileCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid harness profile command");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(field => !["harness", "description", "expectedRevision"].includes(field))) {
    throw new Error("Unknown harness profile command field");
  }
  const expected = row.expectedRevision;
  if (expected !== undefined && (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0 ||
      expected >= Number.MAX_SAFE_INTEGER)) throw new Error("Invalid harness profile revision");
  return { harness: canonicalRegistrationHarness(row.harness), description: parseHarnessProfileDescription(row.description),
    ...(expected === undefined ? {} : { expectedRevision: expected }) };
}

/** The profile's opening sentence, for the one line a list has room for. */
export function harnessProfileSummary(description: string, limit = 120): string {
  const line = description.trim().split(/\r?\n/u)[0]?.trim() ?? "";
  // A Latin full stop ends a sentence only before a space; "v1.2" is not one.
  const sentence = /^.*?(?:[.!?](?=\s|$)|[。！？])/u.exec(line)?.[0] ?? line;
  const characters = [...sentence];
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("").trimEnd()}…` : sentence;
}
