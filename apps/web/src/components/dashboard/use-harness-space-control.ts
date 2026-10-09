"use client";

import { useRef, useState } from "react";
import { WEB_PROXY_ROUTES, type AgentPreset, type SpaceAgentRegistrationKey } from "@xmatrix/protocol";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { useAgentRegistrationCatalog } from "./agent-capability-select";
import { harnessSpaceCreateCommand, harnessSpaceRegistration, harnessSpaceSwitch } from "./harness-space-switch";
import { useRegistrationCommand } from "./use-registration-command";
import { UserFacingProblem, userErrorMessage } from "../../lib/user-facing-error";

/** All owner switches use the same server commands. Inventory supplies candidates,
 * while the authenticated catalog and command boundary supply current grants. */
export function useHarnessSpaceControl(spaceId?: string | null, token?: string | null, userId?: string) {
  const ready = Boolean(spaceId && token && userId);
  const catalog = useAgentRegistrationCatalog(spaceId ?? "", token ?? "", ready);
  const command = useRegistrationCommand(spaceId ?? "", token ?? "", () => undefined);
  const locked = useRef(false);
  const [pending, setPending] = useState<{ key: SpaceAgentRegistrationKey; on: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const registrationFor = (key: SpaceAgentRegistrationKey) => harnessSpaceRegistration(catalog.data?.registrations, key);

  async function set(key: SpaceAgentRegistrationKey, preset: AgentPreset, on: boolean): Promise<boolean> {
    if (!ready || !catalog.isSuccess || locked.current || key.spaceId !== spaceId || key.ownerUserId !== userId) return false;
    locked.current = true;
    setPending({ key, on });
    setError(null);
    try {
      let toggle = harnessSpaceSwitch(registrationFor(key));
      if (!toggle) throw new UserFacingProblem("Answer this Space's sharing request before enabling the harness.");
      if (toggle.on === on) return true;
      if (toggle.create) {
        await xmatrixApiRequest({ url: WEB_PROXY_ROUTES.space_agent_registration_command(spaceId!), token: token!,
          method: "POST", body: harnessSpaceCreateCommand(key, preset) });
        // Restore may preserve a disabled Space policy; read before completing it.
        const fresh = await catalog.refetch();
        if (fresh.isError) throw fresh.error;
        toggle = harnessSpaceSwitch(harnessSpaceRegistration(fresh.data?.registrations, key));
        if (!toggle || toggle.create) throw new UserFacingProblem("The harness could not be enabled. Refresh and try again.");
        if (toggle.on) return true;
      }
      for (const kind of toggle.changes) if (!(await command.run(key, { kind }))) return false;
      const fresh = await catalog.refetch();
      if (fresh.isError) throw fresh.error;
      return true;
    } catch (cause) {
      setError(userErrorMessage(cause, "Couldn't save the harness switch"));
      return false;
    } finally {
      locked.current = false;
      setPending(null);
    }
  }

  return { catalog, ready: ready && catalog.isSuccess, registrationFor, set, pending, isBusy: () => locked.current,
    error: error ?? (command.notice?.error ? command.notice.text : null) ??
      (catalog.isError ? "This Space's agents could not be read." : null) };
}
