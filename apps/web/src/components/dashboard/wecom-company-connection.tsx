"use client";
import { useEffect, useRef, useState } from "react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { Button } from "@/components/ui/button";
import { xmatrixApiRequest } from "@/lib/query/api-client";
type Installation = { corpId: string; agentId: number; recipients: { memberId: string; recipientRef: string; sourceRef: string }[] };
export function WeComCompanyConnection({ spaceId, token, beforeLink, afterRefresh }: {
  spaceId: string; token: string; beforeLink: () => Promise<void>; afterRefresh: () => Promise<void>;
}) {
  const [test, setTest] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [installation, setInstallation] = useState<Installation | null>(null);
  const work = useRef({ generation: 0, controller: null as AbortController | null });
  useEffect(() => {
    const current = work.current; current.generation++; setInstallation(null); setBusy(false); setError("");
    return () => { current.generation++; current.controller?.abort(); };
  }, [spaceId, token]);
  async function run(start: boolean) {
    if (busy) return;
    const generation = work.current.generation, controller = new AbortController(); work.current.controller = controller;
    const current = () => generation === work.current.generation;
    setBusy(true); setError("");
    try {
      const url = WEB_PROXY_ROUTES.space_app_connection_wecom_install(spaceId), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      if (start) {
        await beforeLink(); if (!current()) return;
        const next = await xmatrixApiRequest<{ url: string }>({ url, token, method: "POST", body: { test }, signal });
        if (!current()) return;
        const native = new URL(next.url);
        if (native.origin !== "https://open.work.weixin.qq.com" || native.pathname !== "/3rdapp/install" || native.username || native.password) throw new Error("invalid install URL");
        window.location.assign(native.toString());
      } else {
        const next = await xmatrixApiRequest<{ installation: Installation | null }>({ url, token, signal });
        if (!current()) return;
        if (next.installation && (!Array.isArray(next.installation.recipients) || next.installation.recipients.length > 20 ||
            next.installation.recipients.some(value => !value || !/^member-[a-f0-9]{64}$/u.test(value.recipientRef) || value.sourceRef !== `wecom:${value.recipientRef}`))) throw new Error("invalid member range");
        setInstallation(next.installation); await afterRefresh();
      }
    } catch { if (current()) setError("WeCom company connection could not be confirmed. Check the company authorization and start again."); }
    finally { if (current()) setBusy(false); }
  }
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">Authorize the company application with explicit member visibility. Confirm up to 20 members to receive message notifications and allow replies under each Channel’s action policy. Native message contents stay in WeCom.</p>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={test} disabled={busy} onChange={event => setTest(event.target.checked)} />Use the company test application</label>
    <div className="flex flex-wrap gap-2">
      <Button id="wecom-install-start" size="sm" disabled={busy} onClick={() => void run(true)}>{busy ? "Working…" : "Authorize company"}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(false)}>Refresh connection</Button>
    </div>
    {installation && <div role="status" className="space-y-2 text-sm">
      <p>Company <code>{installation.corpId}</code> · Application <code>{installation.agentId}</code></p>
      {installation.recipients.map(value => <div key={value.recipientRef} className="break-all">
        <p>Member <code>{value.memberId}</code></p><p>Channel subscription: <code>{value.sourceRef}</code></p>
        <p>Send recipient: <code>{value.recipientRef}</code></p>
      </div>)}
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
