/**
 * Connecting a machine from the Web (docs/design/onboarding-connect-machine.md).
 * Every field is derived on the Hub from the terminal's device sign-in, the
 * Machine daemon record and the Space's registrations; the intent itself
 * stores only which terminal and which Machine it led to.
 */
export type SetupIntentPhase =
  /** The command has not been run yet. */
  | "waiting"
  /** A terminal ran it and waits for the owner to compare its code and approve. */
  | "approval"
  /** Approved; the terminal is signing in and starting its daemon. */
  | "connecting"
  /** The Machine reported in; its harnesses and this Space's agents on it follow. */
  | "connected";

export interface SetupIntentHarness {
  id: string;
  installed: boolean;
  /** The harness's own sign-in, when the daemon could check it. */
  login?: "signed_in" | "signed_out" | "unknown";
}

export interface SetupIntentStatus {
  intentId: string;
  spaceId: string;
  expiresAt: string;
  phase: SetupIntentPhase;
  terminal?: { userCode: string; hostname?: string; platform?: string };
  machine?: {
    machineId: string;
    name: string;
    online: boolean;
    /** Absent until the daemon reports its inventory. */
    harnesses?: SetupIntentHarness[];
  };
  /** Harness ids this Space already has on that Machine. */
  registeredHarnesses: string[];
}
