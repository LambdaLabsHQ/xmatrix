import { relayRuntimeCellNamed } from "../relay-authority-locator";
import {
  LiveDeliveryRejectedError,
  publishWithLiveDeliveryRetry,
} from "../relay-authority-live-delivery-retry";
import type { Env } from "../types";
import {
  runtimeDeliveryFailureDiagnostic,
  type RuntimePresenceReason,
} from "./runtime-delivery-diagnostics";
import { relayRuntimeOwnerCellName, type RelayRuntimeOwnerCell } from "./runtime-cell-locator";

/**
 * Live delivery, addressed to principals.
 *
 * Every product socket lives in its owner's own Runtime cell (`user-<id>`): a
 * person's tabs and apps, their Machine Daemons, and the Agent Instances of
 * their registrations. A cell admits no other socket (relay-runtime.ts), so
 * the cells a delivery must reach follow from who it is for, with nothing to
 * look up. The authority names that audience when it publishes; this module
 * turns it into one request per cell, each saying what that cell serves, and
 * sends them within a bounded budget.
 */

export const RUNTIME_CHANNEL_MESSAGE_URL = "https://relay-runtime/internal/product/channel-message";
export const RUNTIME_COMMITTED_EVENT_URL = "https://relay-runtime/internal/committed-event";
export const RUNTIME_CHANNEL_OBSERVABLE_EVENT_URL = "https://relay-runtime/internal/product/channel-observable-event";
export const RUNTIME_CHANNEL_AGENT_PRESENCE_URL = "https://relay-runtime/internal/product/channel-agent-presence";

/** Cells one delivery has in flight at once. */
export const RUNTIME_DELIVERY_CONCURRENCY = 32;

export type RuntimeDeliveryEnv = Pick<Env, "RELAY_RUNTIME" | "XMATRIX_RUNTIME_LOCATION_HINT">;

/** Who one live delivery is for, as the authority named them when it published it. */
export interface RuntimeAudience {
  /** The people it may reach, authorized as it was published. */
  humans: readonly string[];
  /** Owners of the live Agent Instances it is for: their Instances live in their cells. */
  instanceOwners?: readonly string[];
}

/** What one cell serves of a delivery. */
export interface RuntimeCellShare {
  /** The cell's owner. */
  owner: string;
  /** The owner is one of the people the delivery is for. */
  human: boolean;
  /** The owner's Agent Instances are among those it is for. */
  instances: boolean;
}

/** The Runtime cell that is publishing: it serves its own share locally, never by an RPC to itself. */
export type RuntimeLiveDeliverySelf = {
  cellName: string;
  fetch(request: Request): Promise<Response>;
};

interface RuntimeCellFailure {
  cellName: string;
  error: unknown;
  diagnostic?: string;
}

/**
 * Some cells may already have delivered when another fails. Each cell had its
 * own retry budget, so the aggregate is not retried.
 */
export class RuntimeDeliveryError extends Error {
  constructor(readonly failures: readonly RuntimeCellFailure[]) {
    super(`RelayRuntime delivery failed in ${failures.length} cell(s)` +
      (failures[0]?.diagnostic ? ` [${failures[0].diagnostic}]` : ""), {
      // Error reporters follow standard causes, not routing metadata.
      cause: new AggregateError(failures.map((failure) => failure.error),
        "Runtime delivery failures" + failures.slice(0, 4)
          .map((failure) => failure.diagnostic ? ` [${failure.diagnostic}]` : "").join("")),
    });
    this.name = "RuntimeDeliveryError";
  }
}

/**
 * One delivery's plan: every cell it reaches, once, with what that cell
 * serves. A person who is also the owner of Instances the delivery is for is
 * one cell serving both, never two requests.
 */
export function runtimeDeliveryPlan(audience: RuntimeAudience): Map<RelayRuntimeOwnerCell, RuntimeCellShare> {
  const plan = new Map<RelayRuntimeOwnerCell, RuntimeCellShare>();
  const share = (owner: string) => {
    const cell = relayRuntimeOwnerCellName(owner);
    if (!cell) return undefined;
    let held = plan.get(cell);
    if (!held) plan.set(cell, held = { owner, human: false, instances: false });
    return held;
  };
  for (const owner of audience.humans) {
    const held = share(owner);
    if (held) held.human = true;
  }
  for (const owner of audience.instanceOwners ?? []) {
    const held = share(owner);
    if (held) held.instances = true;
  }
  return plan;
}

/**
 * Sends a delivery to every cell of its plan, each with its own request.
 * The publishing cell serves its share through `self`, or skips it when it
 * has already served its own sockets. Resolves with the number of cells
 * reached; rejects with every failed cell once all have settled.
 */
export async function deliverToAudience(input: {
  env: RuntimeDeliveryEnv;
  audience: RuntimeAudience;
  /** The request one cell receives for its share. */
  request: (share: RuntimeCellShare) => Request;
  label: string;
  self?: RuntimeLiveDeliverySelf;
  /** The publishing cell already served its own sockets. */
  skipSelf?: boolean;
  reason?: RuntimePresenceReason;
  concurrency?: number;
}): Promise<number> {
  const cells = [...runtimeDeliveryPlan(input.audience)]
    .filter(([cellName]) => !(input.skipSelf && input.self?.cellName === cellName));
  const failures: RuntimeCellFailure[] = [];
  let next = 0;
  const worker = async () => {
    while (next < cells.length) {
      const [cellName, share] = cells[next++]!;
      const failure = await deliverToCell(input, cellName, share);
      if (failure) failures.push(failure);
    }
  };
  const width = Math.max(1, Math.min(input.concurrency ?? RUNTIME_DELIVERY_CONCURRENCY, cells.length));
  await Promise.all(Array.from({ length: width }, worker));
  if (failures.length > 0) throw new RuntimeDeliveryError(failures);
  return cells.length;
}

async function deliverToCell(
  input: Parameters<typeof deliverToAudience>[0],
  cellName: RelayRuntimeOwnerCell,
  share: RuntimeCellShare,
): Promise<RuntimeCellFailure | undefined> {
  let attempts = 0;
  let phase: "fetch" | "response" = "fetch";
  let url = "https://relay-runtime/unknown";
  try {
    await publishWithLiveDeliveryRetry(async () => {
      attempts += 1;
      phase = "fetch";
      const request = input.request(share);
      url = request.url;
      const response = input.self?.cellName === cellName
        ? await input.self.fetch(request)
        : await relayRuntimeCellNamed(input.env, cellName).fetch(request);
      phase = "response";
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new LiveDeliveryRejectedError(response.status,
          `RelayRuntime rejected ${input.label} delivery (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
      }
      return response;
    });
    return undefined;
  } catch (error) {
    return { cellName, error, diagnostic: runtimeDeliveryFailureDiagnostic({
      url, route: "principal", sourceCell: input.self?.cellName, targetCell: cellName,
      reason: input.reason, phase, attempts,
    }) };
  }
}

/** A JSON POST to one Runtime path. */
export function runtimeJsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
