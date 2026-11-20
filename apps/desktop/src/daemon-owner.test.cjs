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

test("a daemon lock whose read is refused is a running daemon's, and only then", async () => {
  const { daemonLockReadRefused } = await import("./daemon-owner.ts");
  const refused = (code) => () => { throw Object.assign(new Error(code), { code }); };
  // Windows: the running daemon's exclusive lock refuses the read.
  assert.equal(daemonLockReadRefused(refused("EBUSY")), true);
  // No lock file, or one nobody holds, says no daemon runs.
  assert.equal(daemonLockReadRefused(refused("ENOENT")), false);
  assert.equal(daemonLockReadRefused(() => "pid=42\n"), false);
});

test("windowsPowerShellCommand always hides the console window", async () => {
  const { windowsPowerShellCommand } = await import("./daemon-owner.ts");
  assert.deepEqual(windowsPowerShellCommand(["-Command", "Get-Date"], 5_000), {
    file: "powershell",
    args: ["-NoProfile", "-NonInteractive", "-Command", "Get-Date"],
    options: { timeout: 5_000, windowsHide: true },
  });
});

test("daemonStatusChanged ignores heartbeat timestamp refreshes when state is unchanged", async () => {
  const { daemonStatusChanged } = await import("./daemon-owner.ts");
  const running = {
    state: "running",
    pid: 42,
    message: "xMatrix daemon is managed by the local service (pid 42); Hub reconnection is managed by the daemon.",
    updatedAt: "2026-11-20T16:00:00.000Z",
  };
  assert.equal(
    daemonStatusChanged(running, { ...running, updatedAt: "2026-11-20T16:00:30.000Z" }),
    false,
  );
  assert.equal(
    daemonStatusChanged(running, { ...running, pid: 99, updatedAt: "2026-11-20T16:00:30.000Z" }),
    true,
  );
  assert.equal(
    daemonStatusChanged(running, {
      state: "error",
      message: "failed",
      failure: { stage: "service_start", detail: "denied", exitCode: 1 },
      updatedAt: "2026-11-20T16:00:30.000Z",
    }),
    true,
  );
});
