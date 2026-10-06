import assert from 'node:assert/strict';
import test from 'node:test';
import { receiveGrafanaDelivery } from '../src/connectors/wave2-events.ts';

const base = { receiver: 'xmatrix-e2e', groupKey: `{}:{alertname="${'long-group-key-'.repeat(40)}"}`,
  status: 'firing', alerts: [{ fingerprint: 'fingerprint-1', startsAt: '2026-10-03T20:00:00Z', status: 'firing',
    labels: { alertname: 'E2E' }, annotations: { summary: 'First alert' } }] };
async function id(payload) {
  const result = await receiveGrafanaDelivery({ rawBody: JSON.stringify(payload),
    headers: new Headers({ authorization: 'Bearer test-token' }), url: new URL('https://hub.test/grafana'),
    credentials: { webhookToken: 'test-token' } });
  assert.equal(result.ok, true);
  return result.events[0].eventId;
}

test('long Grafana group keys preserve firing/resolved and recurring alert identity', async () => {
  const firing = await id(base);
  const resolved = await id({ ...base, status: 'resolved', alerts: [{ ...base.alerts[0], status: 'resolved' }] });
  assert.notEqual(firing, resolved, 'resolution must appear after the firing notification');
  assert.equal(await id(JSON.parse(JSON.stringify(base))), firing, 'exact redelivery deduplicates');
  assert.notEqual(await id({ ...base, alerts: [{ ...base.alerts[0], startsAt: '2026-10-03T21:00:00Z' }] }), firing,
    'a recurring firing with the same fingerprint is a new lifecycle');
  assert.match(firing, /^grafana:[0-9a-f]{64}$/);
  assert.ok(firing.length < 100, 'the complete hash fits the ingress message id budget');
});

test('identity includes all grouped alerts and is independent of their order', async () => {
  const alerts = Array.from({ length: 8 }, (_, i) => ({ ...base.alerts[0], fingerprint: `fingerprint-${i}` }));
  const first = await id({ ...base, alerts });
  assert.equal(await id({ ...base, alerts: [...alerts].reverse() }), first);
  assert.notEqual(await id({ ...base, alerts: alerts.map((alert, i) => i === 7 ? { ...alert, startsAt: 'later' } : alert) }), first,
    'alerts beyond the five-item display preview still contribute to identity');
  assert.notEqual(await id({ ...base, alerts, receiver: 'different-contact-point' }), first);
  assert.notEqual(await id({ ...base, alerts, groupKey: `${base.groupKey}different-tail` }), first);
});
