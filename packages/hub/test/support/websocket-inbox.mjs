/** Queue socket frames until a bounded test waiter claims them. */
export function websocketInbox(ws, { cleanupExpiredWaiters = false, timeoutLabel = "timed out" } = {}) {
  const received = [];
  const waiters = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    received.push(message);
  });
  return {
    waitFor(predicate, label, timeoutMs = 15_000) {
      const index = received.findIndex(predicate);
      if (index >= 0) return Promise.resolve(received.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (cleanupExpiredWaiters) {
            const waiterIndex = waiters.findIndex((waiter) => waiter.timer === timer);
            if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          }
          reject(new Error(`${timeoutLabel} waiting for ${label}`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, timer });
      });
    },
  };
}
