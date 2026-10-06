"use client";

import { useState } from "react";
import { WEB_PROXY_ROUTES, type AgentRegistrationDetails, type SpaceAgentRegistrationKey } from "@xmatrix/protocol";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { registrationEnvironmentCommand, registrationSpaceCommand, type EnvironmentChange, type EnvironmentState,
  type RegistrationChange } from "./registration-space-command";

/** Stable identity of one registration tuple, for busy flags and React keys. */
export function registrationTupleId(key: SpaceAgentRegistrationKey): string {
  return JSON.stringify([key.spaceId, key.ownerUserId, key.machineId, key.harness]);
}

/** Runs one registration command against the current server state: read the
 * registration, build the command from what was read, then submit it. */
export function useRegistrationCommand(spaceId: string, token: string, onChanged: () => void) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);

  async function run(key: SpaceAgentRegistrationKey, change: RegistrationChange | EnvironmentChange): Promise<boolean> {
    if (pendingId) return false;
    setPendingId(registrationTupleId(key));
    setNotice(null);
    try {
      if (change.kind === "disable" || change.kind === "enable") {
        // The owner's switch for this agent on its machine, in every Space.
        const physical = { ownerUserId: key.ownerUserId, machineId: key.machineId, harness: key.harness };
        const current = await xmatrixApiRequest<EnvironmentState>({
          url: WEB_PROXY_ROUTES.agent_environment_query, token, method: "POST", body: physical });
        await xmatrixApiRequest({ url: WEB_PROXY_ROUTES.agent_environment_command, token, method: "POST",
          body: registrationEnvironmentCommand(current, change) });
      } else {
        const current = await xmatrixApiRequest<AgentRegistrationDetails>({
          url: WEB_PROXY_ROUTES.space_agent_registration_query(spaceId), token, method: "POST", body: key });
        const body = registrationSpaceCommand(key, current, change);
        await xmatrixApiRequest({ url: WEB_PROXY_ROUTES.space_agent_registration_command(spaceId), token, method: "POST",
          body: { ...body, commandId: `registration-ui:${crypto.randomUUID()}` } });
      }
      setNotice({ error: false, text: change.kind.endsWith("disable") ? "Disabled." : change.kind.endsWith("enable") ? "Enabled."
        : "Saved." });
      onChanged();
      return true;
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : "Registration update failed" });
      return false;
    } finally {
      setPendingId(null);
    }
  }

  return { run, pendingId, notice };
}
