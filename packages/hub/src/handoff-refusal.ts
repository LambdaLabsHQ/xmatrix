/**
 * What the Channel reads when a handoff did not start a successor: what
 * happened to the source, why, and what to write next, in words. The code
 * travels beside the text (CommandResultNote.code) so a client words it in its
 * reader's language; the text keeps it in brackets at its end for CLI and
 * Agent readers.
 */
export function handoffRefusalText(address: string, successor: string, code: string): string {
  // Only the successor launch runs after the source has stopped (launchHandoffSuccessor).
  const stopped = `${address} stopped and its work is kept, but ${successor} did not start`;
  // A successor xMatrix already chose for itself gets no better pick from @auto again.
  const auto = /^@auto$/iu.test(successor.trim()) ? `${address}:handoff:@<another Agent>` : `${address}:handoff:@auto`;
  const reason = ((): string => {
    switch (code) {
      case "registration_quota_exhausted":
        return `${stopped}: every ${successor} that could take over has used up its provider quota. ` +
          `Hand the work to another Agent with ${auto}, or send the same handoff again after the quota resets.`;
      case "registration_not_found":
      case "registration_harness_unavailable":
      case "registration_machine_unavailable":
        return `${stopped}: no machine available to this conversation can run ${successor} here. ` +
          `Hand the work to another Agent with ${auto}, or connect a machine that runs ${successor}.`;
      case "registration_daemon_offline":
        return `${stopped}: the computer that runs ${successor} is offline. ` +
          `Bring it back online and send the same handoff again, or hand the work to another Agent with ${auto}.`;
      case "handoff_source_stop_pending":
        return `${address} is still stopping, so ${successor} has not started yet. ` +
          `Send the same handoff again once ${address} shows Stopped.`;
      case "handoff_source_stop_unavailable":
        return `${address} could not be stopped for the handoff, so ${successor} did not start. ` +
          `${address} keeps its work. Check that its computer is online, then send the handoff again.`;
      case "handoff_location_conflict":
        return `${successor} must continue in ${address}'s own repository or directory. ` +
          "Remove the repo: or pwd: condition and send the handoff again.";
      case "handoff_source_not_transferable":
        return `${address} works for this Space's management or a direct conversation and stays where it is. ` +
          `Start ${successor} on its own instead.`;
      case "invalid_registration_launch":
        return `The handoff could not be read. Write it as ${address}:handoff:@<agent>, for example ${address}:handoff:@auto.`;
      case "registration_handoff_failed":
        return `xMatrix could not finish handing ${address} off to ${successor}. ` +
          `Check whether ${address} is still running, then send the handoff again or hand the work to another Agent with ${auto}.`;
      default:
        if (code.startsWith("registration_")) return `${stopped}. Hand the work to another Agent with ${auto}, or try again.`;
        return `${address} was not handed off to ${successor}. Try again, or hand the work to another Agent with ${auto}.`;
    }
  })();
  return `${reason} [${code}]`;
}
