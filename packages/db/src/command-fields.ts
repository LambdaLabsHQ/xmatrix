import { utf8ByteLength } from "@xmatrix/protocol";

/**
 * The readers a command authority validates request fields with. Each throws
 * `invalid(field)` for a value it refuses, so every authority keeps its own
 * error type and code.
 */
export function commandFields(invalid: (field: string) => Error) {
  const fields = {
    /** A required string, trimmed, of at most `maximum` UTF-8 bytes. */
    text(value: unknown, field: string, maximum = 300): string {
      const result = typeof value === "string" ? value.trim() : "";
      if (!result || utf8ByteLength(result) > maximum) throw invalid(field);
      return result;
    },
    /** A safe integer no smaller than `minimum`. */
    integer(value: unknown, field: string, minimum = 0): number {
      const result = Number(value);
      if (!Number.isSafeInteger(result) || result < minimum) throw invalid(field);
      return result;
    },
    /** A JSON object: not null and not an array. */
    object(value: unknown, field: string): Record<string, unknown> {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(field);
      return value as Record<string, unknown>;
    },
    /** The user or Agent a command acts for; a principal of any other kind is `forbidden()`. */
    principal(value: unknown, forbidden: () => Error): { kind: "user" | "agent"; id: string } {
      const principal = fields.object(value, "principal");
      if (principal.kind !== "user" && principal.kind !== "agent") throw forbidden();
      return { kind: principal.kind, id: fields.text(principal.id, "principal.id") };
    },
  };
  return fields;
}
