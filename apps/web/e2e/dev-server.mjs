import { spawn } from "node:child_process";
import { isCliMain } from "../../../scripts/cli-entrypoint.mjs";

import { WEB_E2E_FIXTURE_ENV } from "./fixture-env.mjs";

/* The app the browser specs drive, served by `next dev`: a source edit is on
   the page in seconds, where `pnpm e2e:build` takes minutes. For working on a
   spec or reading the page frame by frame; CI still runs the built app.

     pnpm e2e:dev            # serves on 4612
     PLAYWRIGHT_PORT=4612 PLAYWRIGHT_REUSE_SERVER=1 PLAYWRIGHT_PREBUILT=1 \
       pnpm exec playwright test e2e/<spec> --project=web

   It keeps its output in .next-dev, so a built .next beside it stays usable.
   A development build mounts components twice and is slower; a spec that
   counts mounts or renders can differ here. `next dev` rewrites
   next-env.d.ts for its output directory: restore that file before committing. */
const WEB_E2E_DEV_PORT = 4612;

if (isCliMain(import.meta.url)) {
  const port = process.argv[2] ?? String(WEB_E2E_DEV_PORT);
  const server = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "next", "dev", "--turbopack", "-p", port], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...WEB_E2E_FIXTURE_ENV, XMATRIX_NEXT_DIST_DIR: ".next-dev" },
  });
  server.on("exit", (code) => { process.exitCode = code ?? 1; });
}
