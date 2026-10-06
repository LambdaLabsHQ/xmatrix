import { ControlError } from "@xmatrix/db";
import { runtimePresenceBoundary } from "./runtime-namespace.mjs";
/** Injected Hub boundary for the Channel catalog paging routes. */
export const state = { payload: null, runtimeSessions: [], requests: [], runtimeFetch: null, authorityResult: null };

export const requireAuth = async () => ({ id: "viewer" });
export const requestErrorResponse = (c, error) => c.json({ error: error.message }, error.status || 500);

/** The injected catalog answer, or the refusal a test set as `authorityResult`. */
function answer(kind, input) {
  state.requests.push({ kind, input });
  if (state.authorityResult) throw new ControlError("refused", state.authorityResult.response.status, "refused");
  return state.payload;
}

export const channelCatalogPage = async (_env, input) => answer("list-channel-catalog-page", input);
export const resolveChannelCatalog = async (_env, input) => answer("resolve-channel-catalog", input);

export const getRelayRuntime = () => runtimePresenceBoundary(state, (request) =>
  state.runtimeFetch ? state.runtimeFetch(request) : Response.json({ sessions: state.runtimeSessions }));

/** One complete page from the same injected payload. */
export async function listChannels(_env, input) {
  const page = answer("list-channels", input);
  return { ...page, channels: page?.channels ?? [], cursor: null };
}

export async function listSpaces(_env, principal) {
  answer("list-spaces", { principal });
  return state.payload?.spaces ?? [];
}

/** Attention projections contribute nothing to these reads. */
export const readSpaceAttentionProjection = async () => [];
