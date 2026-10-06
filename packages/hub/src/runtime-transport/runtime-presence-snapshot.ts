/** Read one internal Runtime presence snapshot without defining shared domain state. */
export async function loadRuntimePresenceSnapshotEntries(
  runtime: { fetch(request: Request): Promise<Response> },
  url: URL,
): Promise<unknown[]> {
  return await tryLoadRuntimePresenceSnapshotEntries(runtime, url) ?? [];
}

/** Null means unavailable, distinct from an authoritative empty snapshot. */
export async function tryLoadRuntimePresenceSnapshotEntries(
  runtime: { fetch(request: Request): Promise<Response> },
  url: URL,
  timeoutMs?: number,
): Promise<unknown[] | null> {
  const controller = new AbortController();
  const request = new Request(url, {
    method: "GET", headers: { "cache-control": "no-store" }, signal: controller.signal,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async (): Promise<unknown[] | null> => {
    try {
      const response = await runtime.fetch(request);
      if (controller.signal.aborted || !response.ok) {
        // Cleanup must not hold legacy callers (which have no deadline) open.
        void response.body?.cancel().catch(() => undefined);
        return null;
      }
      const reader = response.body?.getReader();
      if (!reader) return null;
      const cancel = () => { void reader.cancel().catch(() => undefined); };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        const decoder = new TextDecoder();
        let text = "";
        while (!controller.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
        }
        if (controller.signal.aborted) return null;
        const payload = JSON.parse(text + decoder.decode()) as { sessions?: unknown };
        return Array.isArray(payload?.sessions) ? payload.sessions : null;
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
    } catch {
      return null;
    }
  };
  try {
    if (timeoutMs === undefined) return await read();
    return await Promise.race([read(), new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        if (!request.signal.aborted) controller.abort();
        resolve(null);
      }, timeoutMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
