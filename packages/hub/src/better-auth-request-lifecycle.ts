export async function runBetterAuthHandlerWithObservedHookFailure(
  run: () => Promise<Response>,
  observedFailure: () => unknown,
): Promise<Response> {
  const response = await run();
  const failure = observedFailure();
  if (failure) throw failure;
  return response;
}
