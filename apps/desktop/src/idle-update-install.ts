/*
 * A downloaded update installs by itself: the App restarts into it once the
 * person has left the computer (idle for IDLE_INSTALL_SECONDS, or the screen
 * locks), so nobody has to quit xMatrix to finish an automatic update. The
 * daemon is its own process, so running Agents are untouched by the restart.
 */
export const IDLE_INSTALL_SECONDS = 5 * 60;
const IDLE_PROBE_MS = 60_000;

type PowerMonitorLike = {
  getSystemIdleTime: () => number;
  on: (event: "lock-screen", listener: () => void) => unknown;
  removeListener: (event: "lock-screen", listener: () => void) => unknown;
};

/** Installs once the computer is idle; the returned function cancels the wait. */
export function installWhenIdle(options: {
  powerMonitor: PowerMonitorLike;
  install: () => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): () => void {
  const setTimer = options.setTimer ?? ((callback, ms) => setInterval(callback, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
  let done = false;
  let timer: unknown;
  const cancel = () => {
    if (done) return;
    done = true;
    clearTimer(timer);
    options.powerMonitor.removeListener("lock-screen", installNow);
  };
  function installNow() {
    if (done) return;
    cancel();
    options.install();
  }
  const probe = () => {
    if (options.powerMonitor.getSystemIdleTime() >= IDLE_INSTALL_SECONDS) installNow();
  };
  options.powerMonitor.on("lock-screen", installNow);
  timer = setTimer(probe, IDLE_PROBE_MS);
  probe();
  return cancel;
}
