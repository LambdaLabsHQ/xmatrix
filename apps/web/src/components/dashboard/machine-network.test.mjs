import assert from 'node:assert/strict';
import test from 'node:test';
import { machineNetworkText } from './machine-network.ts';
test('network display keeps HTTP failures, ICMP uncertainty and short bandwidth samples distinct', () => {
  assert.equal(machineNetworkText(undefined), 'network unmeasured');
  const network = { attempts: 10, failures: 2, latencyMedianMs: 10, latencyP95Ms: 40, jitterMs: 8,
    download: { mbps: 120, shortSample: true } };
  const text = machineNetworkText(network);
  assert.match(text, /requests failed 2\/10/);
  assert.match(text, /ICMP loss unknown/);
  assert.match(text, /120.0 Mbps \(short sample\)/);
  assert.match(machineNetworkText({ ...network, packetLoss: { sent: 20, received: 19 } }), /5.0% \(20 ICMP probes\)/);
});
