"use client";

import { useEffect, useRef, useState } from "react";
import { WEB_PROXY_ROUTES, type SerializedSpace } from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { buttonVariants } from "@/components/ui/button";
import { GlassSelect } from "@/components/ui/glass-select";
import { InstallationConsent, InstallationOutcome } from "./installation-consent";

interface InstallationRequest { code: string; installationId: string; organization: string }

export function SentryInstallationConfirmation() {
  const { session, user, loading } = useAuth();
  const request = useRef<InstallationRequest | null>(null);
  const initialized = useRef(false);
  const [organization, setOrganization] = useState("");
  const [spaces, setSpaces] = useState<SerializedSpace[]>([]);
  const [selected, setSelected] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [spent, setSpent] = useState(false);
  const [error, setError] = useState("");
  const [listing, setListing] = useState(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const query = new URLSearchParams(window.location.search);
    const code = query.get("code") ?? "";
    const installationId = query.get("installationId") ?? "";
    const org = query.get("orgSlug") ?? query.get("sentryOrgSlug") ?? "";
    const organizationKeys = ["orgSlug", "sentryOrgSlug"];
    // Keep the one-use code in memory only; never forward it through login or app navigation.
    window.history.replaceState(null, "", window.location.pathname);
    if (query.getAll("code").length !== 1 || query.getAll("installationId").length !== 1 ||
        organizationKeys.some(key => query.getAll(key).length > 1 || query.getAll(key).some(value => value !== org)) ||
        !/^[\x21-\x7e]{1,8192}$/u.test(code) ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(installationId) ||
        !/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(org)) {
      setSpent(true);
      setError("This installation request is missing or invalid. Start again from Apps → Sentry.");
      return;
    }
    request.current = { code, installationId, organization: org };
    setOrganization(org);
  }, []);
  useEffect(() => {
    if (!session || !user) { setSpaces([]); setSelected(""); return; }
    const abort = new AbortController();
    setListing(true);
    xmatrixApiRequest<{ spaces: SerializedSpace[] }>({ url: WEB_PROXY_ROUTES.spaces,
      token: session.access_token, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) }).then(result => {
      if (abort.signal.aborted) return;
      setSpaces(result.spaces.filter(space => space.ownerId === user.id || space.members.some(member =>
        member.userId === user.id && (member.role === "owner" || member.role === "admin"))));
      setSelected("");
      setConfirmed(false);
    }).catch(() => {
      if (!abort.signal.aborted) setError("Your Spaces could not be loaded. Return to Apps and start again.");
    }).finally(() => { if (!abort.signal.aborted) setListing(false); });
    return () => abort.abort();
  }, [session, user]);

  async function connect() {
    if (pending || spent || !confirmed || !selected || !session || !request.current) return;
    const input = request.current;
    request.current = null;
    setSpent(true);
    setPending(true);
    setError("");
    try {
      const response = await xmatrixApiRequest<{ ok: boolean }>({
        url: WEB_PROXY_ROUTES.space_app_connection_sentry_install(selected), token: session.access_token,
        method: "POST", body: { ...input, confirmed: true }, signal: AbortSignal.timeout(60_000) });
      if (response.ok !== true) throw new Error("installation was not confirmed");
      window.location.assign(`/app/${encodeURIComponent(selected)}/apps?connector=sentry&oauth=connected`);
    } catch {
      // Do not replay a possibly consumed code, or display provider/private error payloads.
      setError("The installation could not be confirmed. Return to Apps → Sentry and start a fresh installation.");
      setPending(false);
    }
  }

  return <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 px-6 py-12">
    <h1 className="text-2xl font-semibold">Connect Sentry</h1>
    <p className="text-sm text-muted-foreground">Choose the xMatrix Space for Sentry organization <strong>{organization || "—"}</strong>.</p>
    {loading ? <p>Checking your sign-in…</p> : !session ? <>
      <p className="text-sm">Sign in in a separate tab, then return here to confirm this installation.</p>
      <a className={buttonVariants({ variant: "default" })} href="/login?next=%2Fapp" target="_blank" rel="noopener noreferrer">Sign in to xMatrix</a>
    </> : <>
      <label className="flex flex-col gap-2 text-sm">xMatrix Space
        <GlassSelect aria-label="xMatrix Space" value={selected} disabled={pending || spent || listing}
          placeholder={listing ? "Loading Spaces…" : "Choose a Space"}
          options={spaces.map(space => ({ value: space.id, label: space.name }))}
          onChange={value => { setSelected(value); setConfirmed(false); }} />
      </label>
      {!listing && !spaces.length && <p className="text-sm">You need to be an owner or admin of a Space to connect Sentry.</p>}
      <InstallationConsent confirmed={confirmed} disabled={!selected || pending || spent} pending={pending}
        ready={!!selected && !listing} onChange={setConfirmed} onConfirm={() => void connect()}>
        I confirm this organization and Space. This replaces any existing Sentry connection in the selected Space.
      </InstallationConsent>
    </>}
    <InstallationOutcome error={error} href={selected ? `/app/${encodeURIComponent(selected)}/apps?connector=sentry` : "/app"} />
  </main>;
}
