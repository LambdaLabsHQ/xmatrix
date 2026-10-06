"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { xmatrixApiRequest } from "@/lib/query/api-client";

type Binding = { chatSpace: string; sourceRef: string };
type Challenge = { chatSpace: string; nonce: string; expiresAt: string; botUsername?: string };

/** The short-lived confirmation stays only in this mounted Human form, outside the query cache. */
export function GoogleChatRoomLink({ spaceId, token, beforeLink, afterRefresh, provider = "googlechat" }: {
  spaceId: string; token: string; provider?: "googlechat" | "feishu" | "telegram" | "teams"; beforeLink: () => Promise<void>; afterRefresh: () => Promise<void>;
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
    catch (caught) { if (current()) setError((caught as Error).message); }
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
        throw new Error(`${label} confirmation expired. Start again.`);
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
        throw new Error(`${label} connection could not be confirmed.`);
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

  return <div id={`${provider}-room-link`} className="space-y-3">
    <p className="text-sm text-muted-foreground">{isTeams ? "Install the xMatrix company app in your company Teams personal or group chat. Start confirmation here, then send the private code to xMatrix in that conversation. One conversation can be linked per Space; team channels are not supported yet." : isTelegram ? "Add the xMatrix company bot to your Telegram group with permission to send messages, then enter the negative group ID. A Telegram group administrator must send the confirmation; each Space supports up to 20 groups. Bot privacy mode determines which later messages Telegram delivers." : isFeishu ? "Install the xMatrix company app in your Feishu tenant and add its bot to a group. Enter that tenant key and group chat ID; each Space supports up to 20 groups." : "Add xMatrix to your Google Chat space, then enter its space ID."}
      {" "}A Space owner or admin must complete the confirmation in {isTeams ? "the selected Teams conversation" : multiple ? "that same group" : "that same Chat space"}.</p>
    <form onSubmit={(event) => void start(event)} className="flex flex-wrap gap-2">
      {isFeishu && <Input id="feishu-tenant-input" aria-label="Feishu tenant key" placeholder="Tenant key" value={tenantKey}
        maxLength={64} disabled={busy} onChange={event => { setTenantKey(event.target.value); setChallenge(null); }} />}
      {!isTeams && <Input id={`${provider}-room-input`} aria-label={`${label} ${multiple ? "group chat" : "space"} ID`} placeholder={isTelegram ? "-100…" : isFeishu ? "oc_…" : "spaces/AAAA…"}
        value={chatSpace} maxLength={135} disabled={busy}
        onChange={(event) => { setChatSpace(event.target.value); setChallenge(null); }} />}
      <Button id={`${provider}-link-start`} size="sm" type="submit" disabled={busy || (!isTeams && !(isTelegram ? /^-[1-9][0-9]{0,15}$/ : isFeishu ? /^[A-Za-z0-9_-]{1,64}\/oc_[A-Za-z0-9]{4,64}$/ : /^spaces\/[A-Za-z0-9_-]{1,128}$/).test(selectedRoom) || (isTelegram && !Number.isSafeInteger(Number(selectedRoom))))}>
        {busy ? "Working…" : "Start confirmation"}
      </Button>
      <Button size="sm" type="button" variant="outline" disabled={busy} onClick={() => void refresh()}>Refresh connection</Button>
    </form>
    {challenge && <div className="space-y-2 text-sm" role="status">
      <p>In {isTeams ? "your chosen Teams conversation" : <code>{challenge.chatSpace}</code>}, send this to xMatrix within three minutes:</p>
      <p className="break-all font-mono">{isTeams ? `link ${challenge.nonce}` : isTelegram ? `/xmatrix_link@${challenge.botUsername} ${challenge.nonce}` : `@xMatrix link ${challenge.nonce}`}</p>
      {isTeams && <p>Mention @xMatrix before the code in a group chat.</p>}
      <p className="text-muted-foreground">Send once, then refresh the connection to confirm it. Keep this confirmation private.</p>
    </div>}
    {bindings.map(binding => <div key={binding.chatSpace} className="space-y-1 text-sm" role="status">
      <p>Connected {multiple ? `${label} group` : isTeams ? "Teams conversation" : "Chat space"}: <code>{binding.chatSpace}</code></p>
      <p className="break-all text-muted-foreground">Channel subscription: <code>{binding.sourceRef}</code></p>
      {(multiple || isTeams) && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void unlink(binding)}>Unlink {isTeams ? "conversation" : "group"}</Button>}
    </div>)}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
