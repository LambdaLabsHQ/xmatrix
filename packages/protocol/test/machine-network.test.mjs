import assert from 'node:assert/strict';
import test from 'node:test';
import { machineNetworkObservation, machineResourceObservation } from '../dist/index.js';

const now = Date.parse('2026-10-15T18:00:00Z');
const at = new Date(now - 60_000).toISOString();
const sample = { observedAt: at, target: 'cloudflare-speed', protocol: 'https', attempts: 10, failures: 1,
  latencyMedianMs: 30, latencyP95Ms: 80, jitterMs: 12,
  download: { observedAt: at, bytes: 1_000_000, durationMs: 1000, mbps: 8, shortSample: false },
  packetLoss: { target: '1.1.1.1', protocol: 'icmp', sent: 20, received: 19 } };

test('network facts cross the authenticated machine-resource boundary without paths or provider secrets', () => {
  const parsed = machineResourceObservation({ observedAt: at, network: { ...sample,
    proxyUrl: 'https://secret.invalid', responseHeaders: { authorization: 'private' } } }, now);
  assert.deepEqual(parsed.network, sample);
});

test('stale/future network facts and fabricated transfer rates never become measurements', () => {
  for (const bad of [{ observedAt: new Date(now + 1).toISOString() },
    { observedAt: new Date(now - 16 * 60_000).toISOString() }, { target: 'http://127.0.0.1' },
    { attempts: 0 }, { failures: 11 }, { latencyMedianMs: 90 }]) {
    assert.equal(machineNetworkObservation({ ...sample, ...bad }, now), undefined);
  }
  const parsed = machineNetworkObservation({ ...sample, download: { ...sample.download, mbps: 8000 } }, now);
  assert.equal(parsed.download, undefined);
  assert.equal(parsed.latencyP95Ms, 80);
  assert.equal(machineNetworkObservation({ ...sample, download: { ...sample.download,
    observedAt: new Date(now - 3 * 3600_000).toISOString() } }, now).download, undefined);
});

test('HTTP failures are separate from ICMP loss; filtered ICMP is unknown, not zero loss', () => {
  const parsed = machineNetworkObservation({ ...sample, failures: 10,
    packetLoss: { ...sample.packetLoss, received: 0 } }, now);
  assert.equal(parsed.failures, 10);
  assert.equal(parsed.latencyMedianMs, undefined);
  assert.equal(parsed.packetLoss, undefined);
});
