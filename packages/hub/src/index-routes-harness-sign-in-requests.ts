import type { Hono } from "hono";
import {
  HUB_ROUTES, agentPresetById, agentPresetForLauncher, harnessSignInRequestNotice, parseHarnessInventory,
  type SerializedMachineDaemon,
} from "@xmatrix/protocol";
import type { Env } from "./types";
import { appendChannelMessage } from "./channel-messages";
import { requireAuth } from "./index-shared";
import { isMachineField, MACHINE_ACTION_DELIVERY, NO_STORE, readActionBody, refuse } from "./machine-action-routes";
import { privateRouteResponse } from "./private-route-response";
import { requestCardAppend } from "./secret-request-card";

/** The card an Agent posts to ask for a harness sign-in. */
export const HARNESS_SIGN_IN_REQUEST_MESSAGE_KIND = "xmatrix.system.harness-sign-in-request";
const LABEL = "xMatrix sign-in request";
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;

export interface HarnessSignInRequestPort {
  authenticate: typeof requireAuth;
  daemons(env: Env, ownerUserId: string): Promise<SerializedMachineDaemon[]>;
  append(env: Env, channelId: string, append: Record<string, unknown>): Promise<unknown>;
}

const PORT: HarnessSignInRequestPort = {
  authenticate: requireAuth,
  daemons: MACHINE_ACTION_DELIVERY.daemons,
  append: appendChannelMessage,
};

/**
 * An Agent Run asks its owner, on a card in its own Channel, to sign a harness
 * in on one of the owner's Machines (its own by default). The card is the
 * signed-out notice a refused summon gets: the owner signs in there, through
 * the Machine's own harness actions. Nothing here touches the Machine.
 */
export function registerHarnessSignInRequestRoutes(app: Hono<{ Bindings: Env }>,
  dependencies: Partial<HarnessSignInRequestPort> = {}): void {
  const port = { ...PORT, ...dependencies };
  app.post(HUB_ROUTES.harness_sign_in_requests, (c) => privateRouteResponse(c, async () => {
    const user = await port.authenticate(c.req.raw, c.env);
    const run = user.agentRun;
    if (!run) return refuse("An Agent Run asks for a sign-in; a person signs in from the Agents page", 403);
    const body = await readActionBody(c.req.raw, 4_096, "Sign-in");
    if (body instanceof Response) return body;
    const named = typeof body.harness === "string" ? body.harness.trim() : "";
    const preset = agentPresetById(named.toLowerCase()) ?? agentPresetForLauncher(named);
    const machineId = body.machineId === undefined ? run.machineId : isMachineField(body.machineId) ? body.machineId : "";
    const reason = body.reason === undefined ? undefined : typeof body.reason === "string" ? body.reason : null;
    const requestId = body.requestId === undefined ? undefined
      : typeof body.requestId === "string" && REQUEST_ID.test(body.requestId) ? body.requestId : null;
    if (!named || !machineId || reason === null || requestId === null) return refuse("Invalid sign-in request", 400);
    if (!preset || preset.id === "custom") return refuse(`${named} is not a harness xMatrix knows`, 400);
    const daemon = (await port.daemons(c.env, run.ownerUserId)).find((item) => item.machineId === machineId);
    if (!daemon) return refuse("That Machine is not one of this Agent's owner's Machines", 404);
    const machineName = (daemon.machineName ?? daemon.name ?? "").trim();
    const item = parseHarnessInventory(daemon.metadata?.harnesses)?.items.find((entry) => entry.id === preset.id);
    if (item && !item.installed) {
      return refuse(`${preset.displayName} is not installed on ${machineName || "that Machine"}. ` +
        `Install it there first: xmatrix harness install ${preset.id}`, 409);
    }
    const notice = harnessSignInRequestNotice({ agentName: run.agentName, ...(reason ? { reason } : {}),
      signedOut: { harness: preset.id, program: preset.displayName, machineId, ...(machineName ? { machineName } : {}) } });
    const append = await requestCardAppend({ prefix: "harness-sign-in-request", channelId: run.channelId,
      body: notice.body, messageKind: HARNESS_SIGN_IN_REQUEST_MESSAGE_KIND, label: LABEL,
      owner: { id: run.ownerUserId, email: user.email },
      // The caller's id makes a retry replay its card and a later request a new one.
      appMetadata: { ...notice.metadata, ...(requestId ? { requestId } : {}) } });
    await port.append(c.env, run.channelId, append);
    return Response.json({ messageId: append.messageId, harness: preset.id, program: preset.displayName, machineId,
      ...(machineName ? { machineName } : {}), ...(item?.login ? { login: item.login } : {}),
      signInHere: Boolean(preset.management?.login) }, { headers: NO_STORE });
  }));
}
