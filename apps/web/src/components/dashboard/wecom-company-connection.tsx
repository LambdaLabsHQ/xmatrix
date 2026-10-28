"use client";
import { useEffect, useRef, useState } from "react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { ConnectorLinkActions, ConnectorRow, ConnectorRows } from "./connector-page";
import { xmatrixApiRequest } from "@/lib/query/api-client";
type Installation = { corpId: string; agentId: number; recipients: { memberId: string; recipientRef: string; sourceRef: string }[] };
export function WeComCompanyConnection({ spaceId, token, beforeLink, afterRefresh, lead = false }: {
  spaceId: string; token: string; beforeLink: () => Promise<void>; afterRefresh: () => Promise<void>; lead?: boolean;
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
  return <div className="space-y-4">
    {installation && <ConnectorRows>
      <ConnectorRow title={<>Company <code>{installation.corpId}</code></>} meta={<>Application <code>{installation.agentId}</code></>} />
      {installation.recipients.map(value => <ConnectorRow key={value.recipientRef} title={<>Member <code>{value.memberId}</code></>}
        meta={<>Channel subscription <code className="break-all">{value.sourceRef}</code> · send recipient <code className="break-all">{value.recipientRef}</code></>} />)}
    </ConnectorRows>}
    <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={test} disabled={busy} onChange={event => setTest(event.target.checked)} />Use the company test application</label>
    <ConnectorLinkActions lead={lead} busy={busy} startLabel="Authorize company" startId="wecom-install-start"
      onStart={() => void run(true)} onRefresh={() => void run(false)} error={error} />
  </div>;
}
