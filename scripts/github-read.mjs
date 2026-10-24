/**
 * Bounded, read-only GitHub evidence transport shared by the train and ledger.
 * A request's deadline includes its body. Network failures and 5xx retry;
 * client errors and malformed JSON fail closed without retrying.
 */
export async function githubRead(pathname, token, { attempts = 5, delayMs = 2_000, binary = false } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(`https://api.github.com${pathname}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "cache-control": "no-cache" },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
    } catch (error) {
      if (error instanceof SyntaxError || attempt >= attempts) {
        throw new Error(`GitHub ${pathname}: ${error.message}`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      continue;
    }
    // Discard error responses before retrying, without retaining their sockets.
    await response.body?.cancel();
    if (response.status < 500 || attempt >= attempts) throw new Error(`GitHub ${pathname}: ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
  }
}
