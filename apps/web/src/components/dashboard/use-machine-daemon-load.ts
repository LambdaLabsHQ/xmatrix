"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { SerializedMachineDaemon } from "@xmatrix/protocol";

import { useAuth } from "@/lib/auth-context";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { AGENT_REFRESH_INTERVAL_MS, fetchMachineDaemons } from "./workspace-shell-modules";

/** Matches the daemon's resource sample cadence. */
const MACHINE_LOAD_REFRESH_INTERVAL_MS = 30_000;

/** The signed-in user's machine daemons: refreshed while relay push is down,
 * and at the resource-sample cadence while the machines view is open. */
export function useMachineDaemonLoad(input: {
  token: string | null | undefined;
  backgroundReady?: boolean;
  relayPushConnectedRef: { current: boolean };
  machinesViewOpen?: boolean;
  setMachineDaemons: Dispatch<SetStateAction<SerializedMachineDaemon[]>>;
}): void {
  const { token, backgroundReady = true, relayPushConnectedRef, machinesViewOpen = false, setMachineDaemons } = input;
  const auth = useAuth();
  const userId = auth.user?.id || "anonymous";
  const enabled = Boolean(token) && backgroundReady;
  const machines = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId }, "machine-daemons", []),
    queryFn: ({ signal }) => fetchMachineDaemons(token!, signal),
    enabled,
    staleTime: 15_000,
    refetchInterval: () => typeof document === "undefined" || document.hidden
      ? false : machinesViewOpen ? MACHINE_LOAD_REFRESH_INTERVAL_MS
        : relayPushConnectedRef.current ? false : AGENT_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
  useEffect(() => {
    if (!enabled) setMachineDaemons([]);
    else if (machines.data) setMachineDaemons(machines.data);
  }, [enabled, machines.data, setMachineDaemons]);
}
