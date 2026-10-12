// The guide's Markdown (docs/guide/*.md) is imported as text, so the pages
// GitHub shows and the pages /docs serves are one source. Both bundlers load
// it through this: webpack for builds, Turbopack for `next dev`.
module.exports = function markdownSource(source) {
  return `export default ${JSON.stringify(source)};`;
};
