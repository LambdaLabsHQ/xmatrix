import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkDuplicates } from "./check-duplicates.mjs";

async function repository(t, files) {
  const root = await mkdtemp(path.join(tmpdir(), "xmatrix-duplicates-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
  await writeFile(path.join(root, ".jscpd.json"), JSON.stringify({
    threshold: 0, minLines: 5, minTokens: 50,
    format: ["javascript", "rust", "yaml", "bash"], reporters: [], gitignore: true,
    ignore: ["**/node_modules/**", "packages/db/migrations/**"],
  }));
  for (const [file, body] of Object.entries(files)) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  return root;
}

const clone = Array.from({ length: 8 }, (_, index) =>
  `const value${index} = calculateValue(input${index}, options${index}, timestamp${index});`).join("\n") + "\n";

test("rejects clones in tests and source files above the upstream line and size limits", async t => {
  const padding = "// padding\n".repeat(120_000);
  const root = await repository(t, {
    "src/large.js": padding + clone,
    "test/large.test.js": padding + clone,
  });
  await assert.rejects(checkDuplicates(root, { silent: true }), /required: 0/);
});

test("rejects a clone even when the overall percentage would round to zero", async t => {
  const unique = "\n".repeat(400_000) + "const uniqueValue = uniqueFunction();\n";
  const root = await repository(t, {
    "src/unique.js": unique,
    "src/first.js": clone,
    "test/second.test.js": clone,
  });
  await assert.rejects(checkDuplicates(root, { silent: true }), /required: 0/);
});

test("rejects inline ignore markers in untracked source before detection", async t => {
  const root = await repository(t, {
    "src/new.js": `// ${["jscpd", "ignore-start"].join(":")}\n${clone}`,
  });
  await assert.rejects(checkDuplicates(root, { silent: true }), /src\/new.js/);
});

test("excludes generated dependencies and immutable database migrations", async t => {
  const root = await repository(t, {
    "src/only.js": clone,
    "node_modules/generated/index.js": clone,
    "packages/db/migrations/historical.js": clone,
  });
  await checkDuplicates(root, { silent: true });
});

test("detects workflow YAML outside apps, packages and scripts", async t => {
  const workflow = "name: Example\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n" +
    Array.from({ length: 12 }, (_, index) =>
      `      - name: Step ${index}\n        env:\n          STEP_INDEX: ${index}\n        run: node scripts/build-${index}.mjs\n`).join("");
  const root = await repository(t, {
    ".github/workflows/first.yml": workflow,
    ".github/workflows/second.yml": workflow,
  });
  await assert.rejects(checkDuplicates(root, { silent: true }), /required: 0/);
});

test("detects extensionless shell hooks", async t => {
  const shell = "#!/bin/sh\nset -eu\n" + Array.from({ length: 12 }, (_, index) =>
    `printf '%s\\n' "value_${index}" "argument_${index}" "option_${index}"\n`).join("");
  const root = await repository(t, {
    ".githooks/first-hook": shell,
    ".githooks/second-hook": shell,
  });
  await assert.rejects(checkDuplicates(root, { silent: true }), /required: 0/);
});

test("fails closed when extensionless executable source has no language mapping", async t => {
  const root = await repository(t, { "scripts/unknown": "#!/usr/bin/env python3\nprint('hello')\n" });
  await assert.rejects(checkDuplicates(root, { silent: true }), /language extension/);
});

test("related-language initialization does not depend on source filenames", async t => {
  const results = [];
  for (const componentName of ["0-component", "z-component"]) {
    const root = await repository(t, {
      "src/first.js": clone,
      "src/second.js": clone,
      [`src/${componentName}.tsx`]: "export const View = (name: string) => (\n<section>\n<span>{name.toUpperCase()}</span>\n</section>\n);\n",
    });
    const config = path.join(root, ".jscpd.json");
    const source = JSON.parse(await readFile(config, "utf8"));
    source.format.push("jsx", "tsx", "typescript", "css");
    await writeFile(config, JSON.stringify(source));
    const checker = new URL("./check-duplicates.mjs", import.meta.url).href;
    const script = `import {checkDuplicates} from ${JSON.stringify(checker)};\nawait checkDuplicates(process.argv[1], {silent:true}).catch(error => console.log(error.message));`;
    results.push(execFileSync(process.execPath, ["--input-type=module", "-e", script, root], { encoding: "utf8" }).trim());
  }
  assert.match(results[0], /gate failed: 1 clone/);
  assert.equal(results[0], results[1]);
});


test("conventional Docker and Make source filenames fail closed without upstream language dispatch", async t => {
  for (const filename of ["Dockerfile", "Dockerfile.production", "Containerfile", "Makefile", "makefile", "GNUmakefile", "Makefile.local"]) {
    const root = await repository(t, { [`src/${filename}`]: clone });
    await assert.rejects(checkDuplicates(root, { silent: true }), error => {
      assert.match(error.message, /explicit language dispatch/);
      assert.ok(error.message.includes(filename), "the unsupported source path must be actionable");
      return true;
    });
  }
});
