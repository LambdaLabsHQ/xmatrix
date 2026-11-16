import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

// Read-only audit. The checked-in spec remains release authority until a PR updates it.
const source = "https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip";
const run = promisify(execFile);
const root = new URL("../",import.meta.url);
const directory = await mkdtemp(join(tmpdir(),"xmatrix-apple-spec-"));
try {
  const response = await fetch(source,{redirect:"error",signal:AbortSignal.timeout(30_000)});
  if(!response.ok || !response.body)throw new Error(`Apple specification download returned HTTP ${response.status}`);
  const chunks=[];let bytes=0;
  for await(const chunk of response.body) {
    bytes+=chunk.byteLength;
    if(bytes>8*1024*1024)throw new Error("Apple specification archive exceeds 8 MiB");
    chunks.push(Buffer.from(chunk));
  }
  const archive=join(directory,"apple.zip"),file=join(directory,"openapi.json");
  await writeFile(archive,Buffer.concat(chunks));
  // Read exactly one archive member to stdout; never extract archive paths.
  const extract = `import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    info=archive.getinfo("openapi.oas.json")
    if info.file_size>16*1024*1024:
        raise ValueError("Apple specification exceeds 16 MiB")
    sys.stdout.buffer.write(archive.read(info))
`;
  const {stdout}=await run("python3",["-c",extract,archive],{maxBuffer:16*1024*1024,timeout:20_000});
  const upstream=JSON.parse(stdout),pinned=JSON.parse(await readFile(new URL("vendor/app-store-connect/openapi.json",root),"utf8"));
  if(!upstream.paths || typeof upstream.paths!=="object" || !/^\d+(?:\.\d+){1,3}$/u.test(upstream.info?.version ?? "")) {
    throw new Error("Apple specification has an invalid version or path catalog");
  }
  await writeFile(file,stdout);
  const compared=await run(process.execPath,["scripts/app-store-connect-openapi.mjs","--check","--compare",file],
    {cwd:root,maxBuffer:1024*1024,timeout:60_000});
  const deprecated = document => {
    const found=[],stack=[[document,""]];let visited=0;
    while(stack.length) {
      if(++visited>500_000)throw new Error("Apple specification exceeds the audit node bound");
      const [value,path]=stack.pop();
      if(!value || typeof value!=="object")continue;
      if(path.split("/").length>64)throw new Error("Apple specification exceeds the audit depth bound");
      if(value.deprecated===true)found.push(path);
      for(const [key,child] of Object.entries(value)) if(child && typeof child==="object")stack.push([child,`${path}/${key.replace(/~/gu,"~0").replace(/\//gu,"~1")}`]);
    }
    return found;
  };
  const prior=new Set(deprecated(pinned)),fresh=deprecated(upstream).filter(path=>!prior.has(path));
  const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const changed=hash(upstream)!==hash(pinned);
  const report=`Apple upstream version ${upstream.info.version}; pinned ${pinned.info.version}.\n`+
    `Document changed: ${changed}. Newly deprecated nodes: ${fresh.length}.\n\n`+
    compared.stdout+"\n"+JSON.stringify({newlyDeprecated:fresh.slice(0,100)},null,2);
  console.log(report);
  if(changed)console.log("::warning::Apple's specification changed. Review the audit and update the pinned source through a PR; no authority was replaced.");
  if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `## App Store Connect specification audit\n\n\`\`\`text\n${report}\n\`\`\`\n\nOfficial source: ${source}\n`);
} finally { await rm(directory,{recursive:true,force:true}); }
