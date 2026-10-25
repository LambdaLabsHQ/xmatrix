import { CLIENT_UPGRADE_REQUIRED_CLOSE_CODE } from "@xmatrix/protocol";
import { RuntimeClientOperationError } from "./runtime-operation-failure";

/**
 * Whether a socket of this owner may live in this Runtime cell.
 *
 * A cell holds only its owner's sockets (runtime-cell-locator.ts), so a
 * delivery for a person reaches every socket of theirs by reaching their cell.
 * The Worker routes a socket by the owner it names; the cell checks that name
 * against the principal the socket authenticates as. `upgrade_required`: the
 * socket named no owner, as only clients older than owner routing do.
 */
export type RuntimeSocketAdmission = "admitted" | "upgrade_required" | "foreign_cell";

export type RuntimeSocketAdmit = (ownerUserId: string) => RuntimeSocketAdmission;

/** A socket this cell may not hold, refused before its connect wrote anything. */
export class RuntimeSocketRefused extends Error {
  constructor(readonly admission: Exclude<RuntimeSocketAdmission, "admitted">) {
    super(admission === "upgrade_required" ? "Client upgrade required" : "Runtime cell is not this account's");
    this.name = "RuntimeSocketRefused";
  }
}

/**
 * What an authority backend calls once a connect's credential names its
 * principal, and before the connect claims, counts or announces anything: a
 * socket this cell may not hold must leave no trace, not even a connection
 * version that would fence the owner's real socket.
 */
export function admissionGate(admit: RuntimeSocketAdmit | undefined): (ownerUserId: string) => void {
  return (ownerUserId) => {
    const admission = admit?.(ownerUserId) ?? "admitted";
    if (admission !== "admitted") throw new RuntimeSocketRefused(admission);
  };
}

/** Closes a socket this cell may not hold, saying why. */
function closeRefusedSocket(socket: WebSocket, admission: Exclude<RuntimeSocketAdmission, "admitted">): void {
  if (admission === "upgrade_required") socket.close(CLIENT_UPGRADE_REQUIRED_CLOSE_CODE, "Client upgrade required");
  else socket.close(1008, "Runtime cell is not this account's");
}

/**
 * Closes a socket hibernation brought back that this cell may not hold, before
 * it is restored, bound or served. True when it was closed.
 */
export function closedIfRefused(socket: WebSocket, admit: RuntimeSocketAdmit | undefined, ownerUserId: string): boolean {
  const admission = admit?.(ownerUserId) ?? "admitted";
  if (admission === "admitted") return false;
  closeRefusedSocket(socket, admission);
  return true;
}

/** Answers and closes a connect this cell refused. */
export function refuseConnect(
  sockets: {
    send(ws: WebSocket, message: never): void;
    sendFailure(ws: WebSocket, requestId: string | undefined, error: unknown, fallback: string): void;
    remove(ws: WebSocket): void;
  },
  ws: WebSocket,
  requestId: string | undefined,
  admission: Exclude<RuntimeSocketAdmission, "admitted">,
  fallback: string,
): void {
  if (admission === "upgrade_required") {
    sockets.send(ws, { type: "error", requestId, message: "Client upgrade required" } as never);
  } else {
    sockets.sendFailure(ws, requestId, new RuntimeClientOperationError("runtime_cell_foreign"), fallback);
  }
  sockets.remove(ws);
  closeRefusedSocket(ws, admission);
}
