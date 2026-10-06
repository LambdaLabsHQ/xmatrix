const assert = require("node:assert/strict");

const test = require("node:test");

let commandLooksLikeXmatrixDaemon;
let parseDaemonLockPid;
let parsePsDaemonProcesses;

test.before(async () => {
  const loaded = await import("./daemon-owner.ts");
  commandLooksLikeXmatrixDaemon = loaded.commandLooksLikeXmatrixDaemon;
  parseDaemonLockPid = loaded.parseDaemonLockPid;
  parsePsDaemonProcesses = loaded.parsePsDaemonProcesses;
});

test("parseDaemonLockPid reads the daemon lock owner", () => {
  assert.equal(parseDaemonLockPid("pid=3528\n"), 3528);
  assert.equal(parseDaemonLockPid("version=1\npid=42\n"), 42);
  assert.equal(parseDaemonLockPid("pid=0\n"), null);
  assert.equal(parseDaemonLockPid("not a lock file\n"), null);
});

test("commandLooksLikeXmatrixDaemon recognizes the shimmed macOS daemon", () => {
  assert.equal(commandLooksLikeXmatrixDaemon("/usr/local/bin/xmatrix daemon"), true);
  assert.equal(commandLooksLikeXmatrixDaemon("/Users/dev/.local/bin/xmatrix-real daemon"), true);
  assert.equal(commandLooksLikeXmatrixDaemon("/Applications/xMatrix.app/Contents/MacOS/xMatrix"), false);
  assert.equal(commandLooksLikeXmatrixDaemon("/Users/dev/.local/bin/xmatrix-real codex --yolo"), false);
});

test("commandLooksLikeXmatrixDaemon recognizes quoted Windows daemon commands", () => {
  assert.equal(
    commandLooksLikeXmatrixDaemon('"C:\\Users\\dev\\.local\\bin\\xmatrix.exe" daemon'),
    true
  );
  assert.equal(
    commandLooksLikeXmatrixDaemon('"C:\\Users\\dev\\.local\\bin\\xmatrix.exe" codex --yolo'),
    false
  );
});

test("parsePsDaemonProcesses returns daemon candidates without the desktop process", () => {
  const processes = parsePsDaemonProcesses(
    [
      " 100 /Applications/xMatrix.app/Contents/MacOS/xMatrix",
      " 200 /Users/dev/.local/bin/xmatrix-real daemon",
      " 300 /usr/local/bin/xmatrix daemon",
      " 400 /Users/dev/.local/bin/xmatrix-real codex --yolo",
    ].join("\n"),
    300
  );

  assert.deepEqual(processes, [
    {
      pid: 200,
      command: "/Users/dev/.local/bin/xmatrix-real daemon",
      source: "process-scan",
    },
  ]);
});
