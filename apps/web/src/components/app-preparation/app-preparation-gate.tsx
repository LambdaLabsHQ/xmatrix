"use client";

import { useEffect, useState } from "react";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { admitAppCompatibility, detectAppCompatibilityIdentity } from "@/lib/app-client-compatibility";
import { xmatrixHubOrigin } from "@/lib/query/api-client";

const RETRY_DELAY_MS = 2000;
const TRICKLE_INTERVAL_MS = 120;
const INITIAL_PROGRESS = 0.04;
// How far into the current step the trickle may creep before the step resolves.
const STEP_TRICKLE_CEILING = 0.9;

export function AppPreparationGate(props: { children: React.ReactNode }) {
  // Admission contains no user data. Keep its observers stable when AuthProvider
  // replaces the account-scoped QueryClient, so admitted children do not unmount
  // and cancel/restart all their first authenticated reads.
  const [admissionClient] = useState(() => new QueryClient());
  useEffect(() => () => admissionClient.clear(), [admissionClient]);
  const hubOrigin = xmatrixHubOrigin();
  const identity = useQuery({
    queryKey: ["app-client-identity", hubOrigin],
    queryFn: detectAppCompatibilityIdentity,
    staleTime: Infinity,
    retry: true,
    retryDelay: RETRY_DELAY_MS,
  }, admissionClient);
  const [progress, setProgress] = useState(INITIAL_PROGRESS);
  const compatibility = useQuery({
    queryKey: ["app-client-compatibility", hubOrigin, identity.data],
    enabled: Boolean(identity.data),
    queryFn: async () => {
      const { decision } = await admitAppCompatibility(identity.data!);
      if (!decision.compatible) {
        window.location.replace("/upgrade-required");
        return false;
      }
      return true;
    },
    retry: true,
    retryDelay: RETRY_DELAY_MS,
    staleTime: Infinity,
  }, admissionClient);
  const ready = compatibility.data === true;

  useEffect(() => {
    if (ready) return;
    const target = STEP_TRICKLE_CEILING;
    const timer = setInterval(() => {
      setProgress((current) => current + (target - current) * 0.06);
    }, TRICKLE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [ready]);

  if (ready) return props.children;
  return (
    <main aria-busy="true" className="flex min-h-dvh items-center justify-center bg-[#f4f0e8] px-6">
      <div
        role="progressbar"
        aria-label="Preparing"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-black/10"
      >
        <div
          className="h-full rounded-full bg-[#7c654c] transition-[width] duration-300 ease-out"
          style={{ width: `${Math.min(progress, 1) * 100}%` }}
        />
      </div>
    </main>
  );
}
