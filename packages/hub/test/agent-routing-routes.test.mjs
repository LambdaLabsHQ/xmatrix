import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';

import {
  registerAgentRoutingRoutes,
} from "../src/index-routes-agent-routing.ts";

test('retired plan and dispatch endpoints reject without allocating a launch', async () => {
  const app = new Hono();
  let authenticated = 0;
  registerAgentRoutingRoutes(app, async () => { authenticated++; return { id: 'user' }; });
  for (const action of ['plan', 'dispatch']) {
    const response = await app.request(`/api/channels/channel/agent-routing/${action}`,
      { method: 'POST', body: JSON.stringify({ task: 'different from published message', sourceMessageId: 'source' }),
        headers: { 'content-type': 'application/json' } }, {});
    assert.equal(response.status, 410);
    assert.equal((await response.json()).code, 'routing_endpoint_retired');
  }
  assert.equal(authenticated, 2);
});
