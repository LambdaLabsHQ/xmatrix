/** Bound provider concurrency and surface every rejected membership check. */
export async function checkGroups<T>(bindings: readonly T[], check: (binding: T) => Promise<void>): Promise<void> {
  for (let offset = 0; offset < bindings.length; offset += 4) {
    const results = await Promise.allSettled(bindings.slice(offset, offset + 4).map(check));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
