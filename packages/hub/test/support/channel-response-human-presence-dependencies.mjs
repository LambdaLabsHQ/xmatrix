import { runtimePresenceBoundary } from "./runtime-namespace.mjs";
/** Injected Hub boundary for the single-Channel presence helper. */
export const state = { reads: [], runtimeSessions: [], runtimeFails: false, readFails: false, requests: [] };

/** The Channel read answers as the PostgreSQL catalog does, or refuses. */
export async function getChannel(_env, input) {
  state.requests.push({ kind: "get-channel", input });
  if (state.readFails) throw Object.assign(new Error("Channel not found"), { status: 404 });
  return state.reads.shift() ?? {};
}

export const getRelayRuntime = () => runtimePresenceBoundary(state, () => {
  if (state.runtimeFails) throw new Error("RelayRuntime unreachable");
  return Response.json({ sessions: state.runtimeSessions });
});
