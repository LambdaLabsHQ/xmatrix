const assert = require("node:assert/strict");
const test = require("node:test");

let installWhenIdle;
let IDLE_INSTALL_SECONDS;
test.before(async () => {
  ({ installWhenIdle, IDLE_INSTALL_SECONDS } = await import("./idle-update-install.ts"));
});

function fakeMonitor(idle) {
  const listeners = new Set();
  return {
    idle,
    getSystemIdleTime() { return this.idle; },
    on: (_event, listener) => listeners.add(listener),
    removeListener: (_event, listener) => listeners.delete(listener),
    lock: () => [...listeners].forEach((listener) => listener()),
    listeners,
  };
}

test("a downloaded update waits while the person is at the computer, then installs once idle", () => {
  const monitor = fakeMonitor(10);
  let probe;
  let installs = 0;
  installWhenIdle({ powerMonitor: monitor, install: () => { installs += 1; },
    setTimer: (callback) => { probe = callback; return 1; }, clearTimer: () => undefined });
  assert.equal(installs, 0);
  monitor.idle = IDLE_INSTALL_SECONDS;
  probe();
  probe();
  assert.equal(installs, 1);
  assert.equal(monitor.listeners.size, 0);
});

test("locking the screen installs at once, and only once", () => {
  const monitor = fakeMonitor(0);
  let installs = 0;
  installWhenIdle({ powerMonitor: monitor, install: () => { installs += 1; },
    setTimer: () => 1, clearTimer: () => undefined });
  monitor.lock();
  monitor.lock();
  assert.equal(installs, 1);
});

test("a cancelled wait never installs", () => {
  const monitor = fakeMonitor(0);
  let probe;
  let installs = 0;
  const cancel = installWhenIdle({ powerMonitor: monitor, install: () => { installs += 1; },
    setTimer: (callback) => { probe = callback; return 1; }, clearTimer: () => undefined });
  cancel();
  monitor.idle = IDLE_INSTALL_SECONDS;
  probe();
  monitor.lock();
  assert.equal(installs, 0);
});
