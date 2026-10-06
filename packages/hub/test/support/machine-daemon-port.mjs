import assert from "node:assert/strict";
// The Machine Daemon socket port over a stub Authority host.
import {
  PostgresMachineDaemonPort,
} from "../../src/runtime-transport/postgres-machine-daemon-port.ts";

/**
 * A port for an already-connected daemon: it never authenticates unless a test
 * says how. Its daemon commands and Run lifecycle reports both reach the stub
 * host as `machine-daemon-control`; a lifecycle report carries `runLifecycleReplica`.
 * Launch updates reach it as `agent-launch-update`.
 */
export function authorityPort(options) {
  const host = options.commands;
  return new PostgresMachineDaemonPort({
    async authenticate() { throw new Error("not used"); },
    daemonCommand: (input) => host.command("machine-daemon-control", input),
    runLifecycleReport: (input) => host.command("machine-daemon-control", input),
    launchUpdate: (input) => host.command("agent-launch-update", input),
    ...options,
  });
}

/** An Authority host that records each command in `calls` and answers with `respond`. */
export function recordingCommands(calls, respond = () => ({})) {
  return {
    async command(name, input) {
      calls.push({ name, input });
      return respond(name, input);
    },
  };
}

/** Delivery acknowledgements, rather than owner presence, prove a launch started. */
export function assertDeliveredCountContract(deliverable) {
  for (const [result, expected] of [[{ delivered: 0 }, false], [{ delivered: 1 }, true], [{}, false]]) {
    assert.equal(deliverable(result), expected);
  }
}
