import { readFileSync } from "node:fs";

const ROUTE_MODULES = [
  "../src/index-routes-auth-space.ts",
  "../src/index-routes-auth-space-instances.ts",
  "../src/index-routes-auth-space-management.ts",
];

/** Read the split route modules in their registration order for source contracts. */
export function readIndexRoutesAuthSpaceSource() {
  return ROUTE_MODULES
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n");
}
