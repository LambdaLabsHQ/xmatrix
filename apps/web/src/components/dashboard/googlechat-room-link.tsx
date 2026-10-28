"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ConnectorAction, ConnectorCopyLine, ConnectorLinkActions, ConnectorRow, ConnectorRows } from "./connector-page";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { UserFacingProblem, userErrorMessage } from "@/lib/user-facing-error";

type Binding = { chatSpace: string; sourceRef: string };
type Challenge = { chatSpace: string; nonce: string; expiresAt: string; botUsername?: string };

/** The short-lived confirmation stays only in this mounted Human form, outside the query cache. */
/** How a provider's group or space is linked, said once where the link is made, and the fine print folded under it. */
export function chatLinkGuide(provider: "googlechat" | "feishu" | "telegram" | "teams"): { lead: string; details: string } {
  if (provider === "teams") return {
    lead: "Install the xMatrix company app in a Teams personal or group chat, start confirmation here, then send the code to xMatrix in that chat.",
    details: "One conversation can be linked per Space; team channels are not supported yet. A Space owner or admin must complete the confirmation in the selected Teams conversation.",
  };
  if (provider === "telegram") return {
    lead: "Add the xMatrix company bot to your Telegram group with permission to send messages, enter the group's negative ID, then a Telegram group administrator sends the confirmation.",
    details: "Each Space links up to 20 groups. Bot privacy mode decides which later messages Telegram delivers. A Space owner or admin must complete the confirmation in that same group.",
  };
  if (provider === "feishu") return {
    lead: "Install the xMatrix company app in your Feishu tenant and add its bot to a group, then enter the tenant key and the group chat ID.",
    details: "Each Space links up to 20 groups. A Space owner or admin must complete the confirmation in that same group.",
  };
  return {
    lead: "Add xMatrix to your Google Chat space, then enter its space ID and confirm there.",
    details: "One Chat space can be linked per Space. A Space owner or admin must complete the confirmation in that same Chat space.",
  };
}

export function GoogleChatRoomLink({ spaceId, token, beforeLink, afterRefresh, provider = "googlechat", lead = false }: {
  spaceId: string; token: string; provider?: "googlechat" | "feishu" | "telegram" | "teams"; beforeLink: () => Promise<void>; afterRefresh: () => Promise<void>;
  /** The page's lead: Start confirmation is its one solid action. */
  lead?: boolean;
}) {
  const [chatSpace, setChatSpace] = useState("");
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [tenantKey, setTenantKey] = useState("");
  const isTeams = provider === "teams";
  const isFeishu = provider === "feishu", isTelegram = provider === "telegram", multiple = !["googlechat", "teams"].includes(provider);
  const label = isTeams ? "Microsoft Teams" : isFeishu ? "Feishu" : isTelegram ? "Telegram" : "Google Chat";
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ generation: number; controller: AbortController | null }>({ generation: 0, controller: null });
  const url = isTeams ? WEB_PROXY_ROUTES.space_app_connection_teams_link(spaceId) : isTelegram ? WEB_PROXY_ROUTES.space_app_connection_telegram_link(spaceId) : isFeishu ? WEB_PROXY_ROUTES.space_app_connection_feishu_link(spaceId) : WEB_PROXY_ROUTES.space_app_connection_googlechat_link(spaceId);
  const selectedRoom = isFeishu ? `${tenantKey.trim()}/${chatSpace.trim()}` : chatSpace.trim();

  useEffect(() => {
    // Changing Space/identity or unmounting fences every pending response.
    const work = pending.current;
    work.generation++;
    setBindings([]); setTenantKey(""); setChallenge(null); setChatSpace(""); setError(null); setBusy(false);
    return () => { work.generation++; work.controller?.abort(); };
  }, [spaceId, token, provider]);

  useEffect(() => {
    if (!challenge) return;
    const timer = setTimeout(() => setChallenge(null), Math.max(0, Date.parse(challenge.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [challenge]);

  async function privateRequest(work: (current: () => boolean, signal: AbortSignal) => Promise<void>) {
    const generation = pending.current.generation;
    const request = new AbortController(); pending.current.controller = request;
    const current = () => generation === pending.current.generation;
    setBusy(true); setError(null);
    try { await work(current, AbortSignal.any([request.signal, AbortSignal.timeout(20_000)])); }
    catch (caught) { if (current()) setError(userErrorMessage(caught, "Couldn't link the room", `Couldn't link the ${label} room`)); }
    finally { if (current()) setBusy(false); }
  }

  async function start(event: FormEvent) {
    event.preventDefault(); setChallenge(null);
    await privateRequest(async (current, signal) => {
      await beforeLink();
      if (!current()) return;
      const result = await xmatrixApiRequest<Challenge>({ url, token, method: "POST", signal,
        body: isTeams ? {} : isFeishu ? { tenantKey: tenantKey.trim(), chatId: chatSpace.trim() } : isTelegram ? { chatId: chatSpace.trim() } : { chatSpace: chatSpace.trim() } });
      if (!current()) return;
      if (!/^[A-Za-z0-9_-]{32}$/.test(result.nonce) || (!isTeams && result.chatSpace !== selectedRoom) ||
          (isTelegram && (typeof result.botUsername !== "string" || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(result.botUsername))) ||
          !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now() ||
          Date.parse(result.expiresAt) > Date.now() + 185_000) {
        throw new UserFacingProblem(`${label} confirmation expired. Start again.`, true);
      }
      setChallenge(isTeams ? { ...result, chatSpace: "pending" } : result);
    });
  }

  async function refresh() {
    await privateRequest(async (current, signal) => {
      const result = await xmatrixApiRequest<{ binding?: Binding | null; bindings?: Binding[]; pending?: boolean }>({ url, token, signal });
      if (!current()) return;
      const next = multiple ? result.bindings : result.binding ? [result.binding] : [];
      if (!Array.isArray(next) || next.length > (multiple ? 20 : 1) || next.some(binding => !binding || typeof binding.chatSpace !== "string" || typeof binding.sourceRef !== "string")) {
        throw new UserFacingProblem(`${label} connection could not be confirmed.`, true);
      }
      setBindings(next);
      if (isTeams ? !result.pending && next.length > 0 : next.some(binding => binding.chatSpace === challenge?.chatSpace)) setChallenge(null);
      await afterRefresh();
    });
  }

  async function unlink(binding: Binding) {
    setChallenge(null);
    await privateRequest(async (current, signal) => {
      const [tenantKey, chatId] = binding.chatSpace.split("/");
      await xmatrixApiRequest({ url, token, method: "DELETE", body: isTeams ? { chatSpace: binding.chatSpace } : isTelegram ? { chatId: binding.chatSpace } : { tenantKey, chatId }, signal });
      if (!current()) return;
      setBindings(previous => previous.filter(value => value.chatSpace !== binding.chatSpace));
      await afterRefresh();
    });
  }

  const valid = isTeams || ((isTelegram ? /^-[1-9][0-9]{0,15}$/ : isFeishu ? /^[A-Za-z0-9_-]{1,64}\/oc_[A-Za-z0-9]{4,64}$/ : /^spaces\/[A-Za-z0-9_-]{1,128}$/).test(selectedRoom)
    && (!isTelegram || Number.isSafeInteger(Number(selectedRoom))));
  const command = challenge ? isTeams ? `link ${challenge.nonce}` : isTelegram ? `/xmatrix_link@${challenge.botUsername} ${challenge.nonce}` : `@xMatrix link ${challenge.nonce}` : "";
  return <div id={`${provider}-room-link`}>
    {bindings.length > 0 ? <ConnectorRows>
      {bindings.map(binding => <ConnectorRow key={binding.chatSpace} testId="chat-link-binding"
        title={<code className="font-mono text-[13px]">{binding.chatSpace}</code>}
        meta={<>Channel subscription <code className="break-all">{binding.sourceRef}</code></>}
        trailing={(multiple || isTeams) ? <ConnectorAction disabled={busy} aria-label={`Unlink ${isTeams ? "conversation" : "group"}`}
          onClick={() => void unlink(binding)}>Unlink</ConnectorAction> : null} />)}
    </ConnectorRows> : null}
    <form onSubmit={(event) => void start(event)} className={cn("flex flex-wrap items-center gap-2", bindings.length > 0 && "mt-2")}>
      {isFeishu && <Input id="feishu-tenant-input" aria-label="Feishu tenant key" placeholder="Tenant key" value={tenantKey}
        className="min-w-0 flex-1 basis-40" maxLength={64} disabled={busy} onChange={event => { setTenantKey(event.target.value); setChallenge(null); }} />}
      {!isTeams && <Input id={`${provider}-room-input`} aria-label={`${label} ${multiple ? "group chat" : "space"} ID`} placeholder={isTelegram ? "Group ID, -100…" : isFeishu ? "Group chat ID, oc_…" : "Space ID, spaces/AAAA…"}
        className="min-w-0 flex-1 basis-48" value={chatSpace} maxLength={135} disabled={busy}
        onChange={(event) => { setChatSpace(event.target.value); setChallenge(null); }} />}
      <ConnectorLinkActions lead={lead} busy={busy} start="submit" startLabel="Start confirmation" startId={`${provider}-link-start`}
        startDisabled={!valid} onRefresh={() => void refresh()} />
    </form>
    {challenge && <div className="mt-4 space-y-1.5 text-[13px] leading-[1.45]" role="status">
      <p>In {isTeams ? "your chosen Teams conversation" : <code>{challenge.chatSpace}</code>}, send this to xMatrix within three minutes{isTeams ? ", mentioning @xMatrix first in a group chat" : ""}:</p>
      <ConnectorCopyLine value={command} label="confirmation" />
      <p className="text-muted-foreground">Send it once, then refresh the connection. Keep it private.</p>
    </div>}
    {error && <p role="alert" className="mt-2 text-[13px] text-destructive">{error}</p>}
  </div>;
}
