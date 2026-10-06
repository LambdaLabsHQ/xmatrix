import { spawnSync } from "node:child_process";
import { join } from "node:path";

const toolNames = ["initdb", "pg_ctl", "createdb", "psql"];

/** Resolve an installed test toolchain; never install packages or borrow a server. */
export function resolveTestPostgresTools({ env = process.env, probe = (command, args) =>
  spawnSync(command, args, { env, encoding: "utf8", timeout: 5_000 }) } = {}) {
  const explicit = env.XMATRIX_TEST_POSTGRES_BIN?.trim();
  const configured = explicit ? undefined : probe("pg_config", ["--bindir"]);
  const candidates = explicit ? [explicit] : ["", ...(configured?.status === 0 && configured.stdout?.trim()
    ? [configured.stdout.trim()] : [])];
  for (const directory of candidates) {
    const tools = Object.fromEntries(toolNames.map(name => [name, directory ? join(directory, name) : name]));
    if (toolNames.every(name => {
      const result = probe(tools[name], ["--version"]);
      return result.status === 0 && /\(PostgreSQL\) 17(?:\.|\s|$)/u.test(result.stdout ?? "");
    })) return tools;
  }
  throw new Error("PostgreSQL 17 test tools (initdb, pg_ctl, createdb, psql) are required; install them and set PATH or XMATRIX_TEST_POSTGRES_BIN. No tests were skipped and no existing database was used.");
}
