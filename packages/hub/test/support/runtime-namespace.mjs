/** Record each requested Runtime cell before handing the frame to its stub. */
export function recordingRuntimeNamespace(calls, handle) {
  return {
    idFromName: (name) => ({ name }),
    get: (id) => ({
      fetch: async (request) => {
        calls.push({ cell: id.name, request: request.clone() });
        return handle(id.name, request);
      },
    }),
  };
}

/** Runtime presence boundary used by injected single-channel and catalog readers. */
export function runtimePresenceBoundary(state, fetchOverride) {
  return {
    async fetch(request) {
      state.requests.push({ kind: "runtime", url: new URL(request.url).pathname });
      return fetchOverride(request);
    },
  };
}
