const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Blank out comments, keeping every line and column where it was. Comments are
 * where a sweep's rule gets explained, and the explanation often quotes the
 * very class names being banned: the rule is about code, not prose.
 * @param {string} source
 */
function strippedOfComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead) => lead + " ".repeat(match.length - lead.length));
}

/**
 * Every non-test source file under `dir` whose name matches `extension`.
 * @param {string} dir
 * @param {RegExp} extension
 * @returns {string[]}
 */
function sourceFiles(dir, extension) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full, extension));
    else if (extension.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * The text from `function name` up to the next top-level export: the function
 * together with the private helpers that follow it.
 * @param {string} source
 * @param {string} name
 */
function functionSectionSource(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

module.exports = { functionSectionSource, sourceFiles, strippedOfComments };

/** Source guards share one repository-relative reader rather than rebuilding test paths. */
module.exports.readDashboardSource = filename => fs.readFileSync(path.join(__dirname, filename), "utf8");
module.exports.webSourceTree = () => {
  const root = path.join(__dirname, "..", "..");
  return {
    files: extension => sourceFiles(root, extension),
    read: filename => fs.readFileSync(filename, "utf8"),
    readRelative: filename => fs.readFileSync(path.join(root, filename), "utf8"),
    relative: filename => path.relative(root, filename),
    basename: filename => path.basename(filename),
  };
};
