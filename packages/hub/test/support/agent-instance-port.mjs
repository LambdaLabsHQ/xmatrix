// The Agent Instance socket port over stub message commands and a runtime that
// record every command they are sent.
import {
  PostgresAgentInstancePort,
} from "../../src/runtime-transport/postgres-agent-instance-port.ts";

/**
 * A port that records each command as `{ family, input, context }`
 * in `commands` and answers it with `respond`; history is inert.
 */
export function recordingAgentInstancePort({ respond = () => ({}), signals = { async publish() {} } } = {}) {
  const commands = [];
  const port = new PostgresAgentInstancePort({
    atomicInstanceConnect: true,
    history: { async join() {}, async leave() {}, async replay() {}, async history() {} },
    messages: {
      async append(input, context) {
        commands.push({ family: "append-message", input, context });
        return respond("append-message", input);
      },
      async acknowledge(input) {
        commands.push({ family: "acknowledge-message", input, context: undefined });
        return respond("acknowledge-message", input);
      },
    },
    runtime: {
      async getRun() { throw new Error("unexpected Run read"); },
      async transition(input) {
        commands.push({ family: "domain", input });
        return respond("domain", input);
      },
      async holdUsageLimit(input) {
        commands.push({ family: "registration-usage-limit-hold", input });
        return respond("registration-usage-limit-hold", input);
      },
    },
    signals,
  });
  return { port, commands };
}
