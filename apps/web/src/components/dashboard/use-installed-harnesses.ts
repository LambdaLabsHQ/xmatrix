"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { fetchMachineDaemons } from "./workspace-admin-views";
import { installedHarnessCandidates } from "./installed-harness-candidates";
import { harnessSpaceSwitch } from "./harness-space-switch";
import { useHarnessSpaceControl } from "./use-harness-space-control";

export function useInstalledHarnesses(spaceId?: string | null, token?: string | null, userId?: string, enabled = true) {
  const control = useHarnessSpaceControl(enabled ? spaceId : null, token, userId);
  const daemons = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId: userId ?? "anonymous" }, "machine-daemons", []),
    queryFn: ({ signal }) => fetchMachineDaemons(token!, signal),
    enabled: Boolean(enabled && spaceId && token && userId), staleTime: 15_000,
  });
  const candidates = spaceId && userId
    ? installedHarnessCandidates(spaceId, userId, daemons.data ?? [], control.catalog.data?.registrations ?? []) : [];
  const [enablingAll, setEnablingAll] = useState(false);
  const bulkLock = useRef(false);
  async function enableAll() {
    if (bulkLock.current || !control.ready || !daemons.isSuccess || control.pending) return;
    bulkLock.current = true;
    setEnablingAll(true);
    try {
      for (const candidate of candidates) {
        const toggle = harnessSpaceSwitch(candidate.registration);
        if (toggle && !toggle.on && !(await control.set(candidate.key, candidate.preset, true))) break;
      }
    } finally {
      bulkLock.current = false;
      setEnablingAll(false);
    }
  }
  return { ...control, candidates, enablingAll, enableAll, daemons,
    ready: control.ready && daemons.isSuccess,
    error: control.error ?? (daemons.isError ? "Your machines could not be read. Try refreshing." : null) };
}
