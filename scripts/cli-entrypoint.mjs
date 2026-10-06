import process from "node:process";
import { pathToFileURL } from "node:url";

export function isCliMain(moduleUrl) {
  return Boolean(process.argv[1] && moduleUrl === pathToFileURL(process.argv[1]).href);
}

export function runCliMain(moduleUrl, main, { errorStack = false } = {}) {
  if (!isCliMain(moduleUrl)) return;

  return main().catch((error) => {
    console.error(errorStack ? error.stack || error.message : error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
