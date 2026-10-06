let count = 0;
export default {
  async fetch(request: Request, env: { RESPONSE_CLOSE?: string }): Promise<Response> {
    const body = await request.text();
    const url = new URL(request.url);
    return Response.json({
      body, path: url.pathname, search: url.search, method: request.method,
      probe: request.headers.get("x-repro-probe"), count: ++count,
    }, {
      headers: env.RESPONSE_CLOSE === "1" ? { Connection: "close" } : {},
    });
  },
};
