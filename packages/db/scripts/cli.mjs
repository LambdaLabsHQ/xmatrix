import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function runIfInvoked(moduleUrl, operation, argv = process.argv) {
  const invokedUrl = argv[1] ? pathToFileURL(resolve(argv[1])).href : "";
  if (invokedUrl !== moduleUrl) return;
  operation().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export async function withClient(client, operation) {
  try {
    return await operation(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function requiredEnv(name, source = process.env) {
  const value = source[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** A client transaction with rollback that preserves the original failure. */
export async function withClientTransaction(client, operation) {
  await client.query("BEGIN");
  try {
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
