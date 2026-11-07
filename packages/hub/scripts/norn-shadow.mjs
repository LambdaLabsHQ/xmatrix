// Explicit, bounded operator pass. No watcher or automatic production cohort.
// Run with: pnpm --dir packages/hub exec node --import tsx scripts/norn-shadow.mjs <config.json>
import { readFile } from "node:fs/promises";
import { createAuthorityDatabase, PostgresNornShadowRepository } from "@xmatrix/db";
import { nornShadowEvaluator } from "../src/norn-shadow-evaluator.ts";

let database;
function fail(error) {
  // Driver messages can include parameters. Only a closed domain code escapes.
  process.stderr.write(JSON.stringify({ error: typeof error?.code === "string" && error.code.startsWith("norn_")
    ? error.code : "norn_comparison_failed" })+"\n");
  process.exitCode = 1;
}
try {
const [path] = process.argv.slice(2);
if (!path) throw new Error("A local comparison configuration file is required");
const input = JSON.parse(await readFile(path,"utf8"));
if (!["admit","step","report","revoke","expire"].includes(input.operation)) throw new Error("Unknown comparison operation");
if (!process.env.POSTGRES_RUNTIME_DATABASE_URL || !process.env.XMATRIX_SECRET_CATALOG_KEY) {
  throw new Error("Inject POSTGRES_RUNTIME_DATABASE_URL and XMATRIX_SECRET_CATALOG_KEY using the secret store");
}
database = createAuthorityDatabase({ connectionString: process.env.POSTGRES_RUNTIME_DATABASE_URL,
  shardId: input.placement.shardId,applicationName: "xmatrix-norn-shadow",connectTimeoutMs: 5000,
  statementTimeoutMs: 5000,transactionTimeoutMs: 10000,lockTimeoutMs: 2000 }).openSession();
  const repository = new PostgresNornShadowRepository(database,input.placement,process.env.XMATRIX_SECRET_CATALOG_KEY.trim(),nornShadowEvaluator);
  const request = { ...input,requestId: crypto.randomUUID() };
  let result;
  if (input.operation === "admit") result = await repository.admit({ ...request,ast: await readFile(input.astFile,"utf8") });
  else if (input.operation === "step") result = await repository.step(request);
  else if (input.operation === "revoke") result = await repository.revoke(request);
  else if (input.operation === "expire") result = { removed: (await repository.maintain(request.requestId)).length };
  else result = await repository.report(request);
  process.stdout.write(JSON.stringify(result,null,2)+"\n");
} catch (error) {
  fail(error);
} finally {
  try { await database?.close(); } catch (error) { fail(error); }
}
