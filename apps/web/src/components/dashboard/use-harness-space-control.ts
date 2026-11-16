"use client";

import { useRef, useState } from "react";
import { WEB_PROXY_ROUTES, type AgentAccessMode, type AgentPreset, type SpaceAgentRegistrationKey } from "@xmatrix/protocol";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { useAgentRegistrationCatalog } from "./agent-capability-select";
import { harnessSpaceCreateCommand, harnessSpaceRegistration, harnessSpaceSwitch } from "./harness-space-switch";
import { useRegistrationCommand } from "./use-registration-command";
import { confirmAccessForAdd } from "./agent-access";
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

  /** Asks the machine's owner once for every harness about to be added whose
   * access they have not confirmed there. Null when they declined. */
  function confirmAdds(adds: ReadonlyArray<{ key: SpaceAgentRegistrationKey; preset: AgentPreset }>) {
    return confirmAccessForAdd(token!, adds.filter(add => harnessSpaceSwitch(registrationFor(add.key))?.create)
      .map(add => ({ key: add.key, name: add.preset.displayName })));
  }

  /** `confirmed` carries the answer of a `confirmAdds` that already asked for this harness. */
  async function set(key: SpaceAgentRegistrationKey, preset: AgentPreset, on: boolean,
    confirmed?: ReadonlyMap<string, AgentAccessMode>): Promise<boolean> {
    if (!ready || !catalog.isSuccess || locked.current || key.spaceId !== spaceId || key.ownerUserId !== userId) return false;
    locked.current = true;
    setPending({ key, on });
    setError(null);
    try {
      let toggle = harnessSpaceSwitch(registrationFor(key));
      if (!toggle) throw new UserFacingProblem("Answer this Space's sharing request before enabling the harness.");
      if (toggle.on === on) return true;
      if (toggle.create) {
        const access = confirmed ?? await confirmAdds([{ key, preset }]);
        if (!access) return false;
        await xmatrixApiRequest({ url: WEB_PROXY_ROUTES.space_agent_registration_command(spaceId!), token: token!,
          method: "POST", body: harnessSpaceCreateCommand(key, preset, access.get(key.harness)) });
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

  return { catalog, ready: ready && catalog.isSuccess, registrationFor, set, confirmAdds, pending, isBusy: () => locked.current,
    error: error ?? (command.notice?.error ? command.notice.text : null) ??
      (catalog.isError ? "This Space's agents could not be read." : null) };
}
