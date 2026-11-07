import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("operator failures redact configuration and credential-like driver inputs",() => {
  const directory = mkdtempSync(join(tmpdir(),"norn-operator-"));
  try {
    const file = join(directory,"invalid.json"),marker = "private-fixture-marker";
    writeFileSync(file,marker);
    const result = spawnSync(process.execPath,["--import","tsx","scripts/norn-shadow.mjs",file],{
      cwd: new URL("../",import.meta.url),encoding: "utf8",timeout: 10000,
      env: { ...process.env,POSTGRES_RUNTIME_DATABASE_URL: marker,XMATRIX_SECRET_CATALOG_KEY: marker },
    });
    assert.equal(result.status,1);
    assert.equal(result.stdout,"");
    assert.deepEqual(JSON.parse(result.stderr),{ error: "norn_comparison_failed" });
    assert.equal(result.stderr.includes(marker),false);
  } finally { rmSync(directory,{ recursive: true,force: true }); }
});
