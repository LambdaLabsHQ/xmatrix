import process from "node:process";
import { pathToFileURL } from "node:url";

export function isCliMain(moduleUrl) {
  return Boolean(process.argv[1] && moduleUrl === pathToFileURL(process.argv[1]).href);
}

export function argumentValue(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index >= 0 && index < argv.length - 1 ? argv[index + 1] : fallback;
}

export function argumentValues(argv, flag) {
  const values = [];
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === flag) values.push(argv[index + 1]);
  }
  return values;
}

export function runCliMain(moduleUrl, main, { errorStack = false } = {}) {
  if (!isCliMain(moduleUrl)) return;

  return main().catch((error) => {
    console.error(errorStack ? error.stack || error.message : error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
