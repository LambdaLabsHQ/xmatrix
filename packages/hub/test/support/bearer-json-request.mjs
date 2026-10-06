/** REST response helper shared by PostgreSQL-backed product scenarios. */
export async function bearerJsonRequest(worker, token, path, init = {}, {
  trimEmpty = false,
  inheritHeaders = true,
} = {}) {
  const response = await worker.fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(inheritHeaders ? init.headers : {}),
    },
  });
  const text = await response.text();
  return { response, payload: (trimEmpty ? text.trim() : text) ? JSON.parse(text) : {} };
}
