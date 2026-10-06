const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** A fresh directory under the OS temp dir whose name starts with `prefix`. */
function scratchDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A CLI config directory signed in to production: `session` is its session
 * file and `broker` its daemon request-broker record.
 */
function cliConfigDirectory(prefix, session, broker) {
  const dir = scratchDirectory(prefix);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ activeEnvironment: "production" }));
  fs.mkdirSync(path.join(dir, "sessions"));
  fs.writeFileSync(path.join(dir, "sessions", "production.json"), JSON.stringify(session));
  fs.writeFileSync(path.join(dir, "daemon-request-broker.json"), JSON.stringify(broker));
  return dir;
}

function managedScratchDirectory(t, prefix) {
  const directory = scratchDirectory(prefix);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

module.exports = { cliConfigDirectory, scratchDirectory, managedScratchDirectory };

module.exports.readDesktopSource = filename => fs.readFileSync(path.join(__dirname, filename), "utf8");
