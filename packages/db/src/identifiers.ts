import { utf8ByteLength } from "@xmatrix/protocol";
import { DatabaseContractError } from "./errors.js";


export function boundedDatabaseIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") throw new DatabaseContractError(`${field} must be a string`);
  const result = value.trim();
  if (!result || utf8ByteLength(result) > 300) {
    throw new DatabaseContractError(`${field} is invalid`);
  }
  return result;
}

export function positiveDatabaseInteger(value: unknown, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new DatabaseContractError(`${field} must be a positive safe integer`);
  }
  return result;
}

/** Normalize PostgreSQL timestamp rows before they cross a directory boundary. */
export function databaseTimestamp(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(
    boundedDatabaseIdentifier(value, field),
  );
  if (!Number.isFinite(date.getTime())) {
    throw new DatabaseContractError(`${field} is invalid`);
  }
  return date.toISOString();
}
