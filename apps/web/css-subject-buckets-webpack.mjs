import postcss from "postcss";

import cssSubjectBuckets from "./css-subject-buckets.mjs";

// Run after Next's CSS minifier so it cannot fold the class guards back into
// :is(), and before source-map emission and Webpack's real content hashing.
export default class CssSubjectBucketsPlugin {
  apply(compiler) {
    const { Compilation, sources } = compiler.webpack;
    compiler.hooks.compilation.tap("CssSubjectBucketsPlugin", (compilation) => {
      compilation.hooks.processAssets.tapPromise({
        name: "CssSubjectBucketsPlugin",
        stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE + 1,
      }, async () => {
        for (const { name, source } of compilation.getAssets()) {
          if (!/\.css(?:\?.*)?$/iu.test(name)) continue;
          const input = source.sourceAndMap();
          const result = await postcss([cssSubjectBuckets()]).process(input.source.toString(), {
            from: name,
            to: name,
            map: input.map ? { prev: input.map, inline: false, annotation: false } : false,
          });
          compilation.updateAsset(name, result.map
            ? new sources.SourceMapSource(result.css, name, result.map.toJSON())
            : new sources.RawSource(result.css));
        }
      });
    });
  }
}
