import { readdirSync, readFileSync, statSync } from "node:fs";

const root = new URL("../../../", import.meta.url);

// Repository-relative paths of the non-test TypeScript sources under `dirs`
// (each relative to the repository root) for which `offends(source, path)`
// holds. Guards that a shared protocol helper is not written out again.
export function sourceOffenders(dirs, offends) {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = new URL(name, dir);
      if (statSync(path).isDirectory()) {
        if (name !== "node_modules" && name !== "dist") walk(new URL(`${name}/`, dir));
      } else if (/\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name)) {
        const relative = path.pathname.slice(root.pathname.length);
        if (offends(readFileSync(path, "utf8"), relative)) offenders.push(relative);
      }
    }
  };
  for (const dir of dirs) walk(new URL(dir, root));
  return offenders;
}
