import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import postcss from "postcss";
import { SourceMapConsumer, SourceMapGenerator } from "source-map-js";

import CssSubjectBucketsPlugin from "./css-subject-buckets-webpack.mjs";

const require = createRequire(import.meta.url);
const nextWebpack = require("next/dist/compiled/webpack/webpack");
nextWebpack.init();
const { webpack } = nextWebpack;
const { CssMinimizerPlugin } = require("next/dist/build/webpack/plugins/css-minimizer-plugin");
const { spans } = require("next/dist/build/webpack/plugins/profiling-plugin");
const { trace } = require("next/dist/trace");

const SOURCE_CSS = `@layer components {
  .scope :is(.alpha, .beta) {
    color: red;
    --artifact-marker: original;
  }
  .tail {
    border-width: 0px;
  }
}
`;
const INITIAL_HASH = "1234567890abcdef";
const INITIAL_CSS_FILE = `static/css/${INITIAL_HASH}.css`;

/** Each input character starts with a real original-source location, so the
 * minifier and subsequent selector expansion must compose both map layers. */
function sourceMap(sourceFile) {
  const map = new SourceMapGenerator({ file: INITIAL_CSS_FILE });
  for (const [index, line] of SOURCE_CSS.split("\n").entries()) {
    for (let column = 0; column <= line.length; column += 1) {
      map.addMapping({ generated: { line: index + 1, column },
        original: { line: index + 1, column }, source: sourceFile });
    }
  }
  map.setSourceContent(sourceFile, SOURCE_CSS);
  return map.toJSON();
}

function fixtureAssets(sourceFile) {
  return {
    apply(compiler) {
      compiler.hooks.thisCompilation.tap("CssArtifactFixture", (compilation) => {
        compilation.hooks.processAssets.tap({ name: "CssArtifactFixture",
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONS }, () => {
          const { RawSource, SourceMapSource } = compiler.webpack.sources;
          compilation.emitAsset(INITIAL_CSS_FILE,
            new SourceMapSource(SOURCE_CSS, INITIAL_CSS_FILE, sourceMap(sourceFile)),
            { contenthash: INITIAL_HASH, immutable: true });
          compilation.namedChunks.get("main").files.add(INITIAL_CSS_FILE);
          // Next's App/build manifests are emitted before asset optimization.
          compilation.emitAsset("early-manifest.json",
            new RawSource(JSON.stringify({ css: INITIAL_CSS_FILE })));
        });
      });
    },
  };
}

function createCompiler(root, sourceFile, bucketed) {
  const compiler = webpack({
    mode: "production",
    context: root,
    entry: path.join(root, "entry.js"),
    output: { path: path.join(root, bucketed ? "bucketed" : "baseline"), filename: "main.js",
      hashFunction: "sha256", hashDigest: "hex", hashDigestLength: INITIAL_HASH.length },
    cache: { type: "memory" },
    optimization: { minimize: false, realContentHash: true },
    plugins: [
      fixtureAssets(sourceFile),
      new CssMinimizerPlugin({ postcssOptions: { map: { inline: false, annotation: false } } }),
      ...(bucketed ? [new CssSubjectBucketsPlugin()] : []),
      new webpack.SourceMapDevToolPlugin({ filename: "[file].map", test: /\.css$/u }),
    ],
  });
  // Next's own minifier expects the tracing context that Next normally puts on
  // its compiler. Keep the actual minifier and actual Span in this small build.
  const span = trace("css-subject-artifact-owner");
  spans.set(compiler, span);
  return { compiler, span };
}

function compile(compiler) {
  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      if (error) reject(error);
      else if (!stats || stats.hasErrors()) reject(new Error(stats?.toString({ all: false, errors: true }) ?? "Missing build result"));
      else resolve(stats.compilation);
    });
  });
}

async function artifact(compiler) {
  const compilation = await compile(compiler);
  const cssAssets = compilation.getAssets().filter((asset) => asset.name.endsWith(".css"));
  assert.equal(cssAssets.length, 1);
  const cssAsset = cssAssets[0];
  const mapFile = cssAsset.info.related?.sourceMap;
  assert.equal(typeof mapFile, "string");
  const css = await readFile(path.join(compiler.outputPath, cssAsset.name), "utf8");
  const map = JSON.parse(await readFile(path.join(compiler.outputPath, mapFile), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(compiler.outputPath, "early-manifest.json"), "utf8"));
  assert.notEqual(cssAsset.name, INITIAL_CSS_FILE, "RealContentHash must rename the emitted CSS");
  assert.equal(manifest.css, cssAsset.name, "early manifests must follow the final content hash");
  assert.equal(mapFile, `${cssAsset.name}.map`, "related maps must follow the CSS rename");
  assert.equal(map.file, cssAsset.name);
  assert.ok(css.includes(`sourceMappingURL=${path.basename(mapFile)}`));
  assert.ok(compilation.namedChunks.get("main").files.has(cssAsset.name));
  assert.ok(!compilation.namedChunks.get("main").files.has(INITIAL_CSS_FILE));
  assert.ok(!compilation.getAsset(INITIAL_CSS_FILE));
  assert.ok(compilation.getAsset(mapFile));
  return { name: cssAsset.name, css, map, manifest };
}

function declarations(css) {
  const values = [];
  postcss.parse(css).walkDecls((declaration) => {
    values.push([declaration.prop, declaration.value, declaration.important]);
  });
  return values;
}

function assertOriginalDeclaration(artifact, property, sourceLine, sourceColumn) {
  const offset = artifact.css.indexOf(property);
  assert.ok(offset >= 0, `${property} must survive the build`);
  const preceding = artifact.css.slice(0, offset).split("\n");
  const consumer = new SourceMapConsumer(artifact.map);
  const original = consumer.originalPositionFor({ line: preceding.length, column: preceding.at(-1).length });
  assert.ok(original.source?.endsWith("fixture-source.css"));
  assert.equal(original.line, sourceLine);
  assert.equal(original.column, sourceColumn);
  assert.equal(consumer.sourceContentFor(original.source), SOURCE_CSS);
}

test("final CSS buckets retain content hashes, manifest links and composed source maps across warm builds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xmatrix-css-artifact-"));
  const compilers = [];
  try {
    const sourceFile = path.join(root, "fixture-source.css");
    await Promise.all([writeFile(path.join(root, "entry.js"), "export const fixture = true;\n"),
      writeFile(sourceFile, SOURCE_CSS)]);
    const baseline = createCompiler(root, sourceFile, false);
    const bucketed = createCompiler(root, sourceFile, true);
    compilers.push(baseline, bucketed);
    const before = await artifact(baseline.compiler);
    const after = await artifact(bucketed.compiler);
    assert.ok(!before.css.includes(":where("));
    assert.ok(after.css.includes(":where(.alpha)") && after.css.includes(":where(.beta)"),
      "the final minified asset must retain both subject buckets");
    assert.notEqual(after.name, before.name, "the selector change must affect the content hash");
    assert.deepEqual(declarations(after.css), declarations(before.css), "declarations and their order must stay intact");
    assertOriginalDeclaration(after, "--artifact-marker", 4, 4);
    assertOriginalDeclaration(after, "border-width", 7, 4);

    const warm = await artifact(bucketed.compiler);
    assert.deepEqual(warm, after, "reusing compiler/minifier caches must produce identical CSS, links and maps");
  } finally {
    for (const { compiler, span } of compilers) {
      await new Promise((resolve, reject) => compiler.close((error) => error ? reject(error) : resolve()));
      spans.delete(compiler);
      span.stop();
    }
    await rm(root, { recursive: true, force: true });
  }
});
