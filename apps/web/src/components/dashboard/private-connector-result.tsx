"use client";

import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";

/** Private values never enter the shared message model, quote/selection actions or Markdown media. */
export function PrivateConnectorResult({ channelId, messageId, ownerUserId, token }: {
  channelId: string; messageId: string; ownerUserId: string; token: string | null;
}) {
  const { user } = useAuth();
  const fetcher = useXMatrixQueryFetch(user?.id);
  const key = `${user?.id}:${channelId}:${messageId}`;
  const [value, setValue] = useState<{ key: string; detail: string } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const owns = Boolean(user?.id && user.id === ownerUserId);
  useEffect(() => {
    setValue(null); setUnavailable(false);
    if (!owns || !token) return;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); setUnavailable(true); }, 15_000);
    void fetcher(WEB_PROXY_ROUTES.channel_message_connector_result(channelId, messageId), {
      headers: { authorization: `Bearer ${token}` }, signal: controller.signal, cache: "no-store",
    }).then(async response => {
      if (!response.ok) throw new Error("Private result is unavailable");
      const payload = await response.json() as { detail?: unknown };
      if (typeof payload.detail !== "string") throw new Error("Private result is invalid");
      if (!controller.signal.aborted) setValue({ key, detail: payload.detail });
    }).catch(() => { if (!controller.signal.aborted) setUnavailable(true); })
      .finally(() => clearTimeout(timer));
    return () => { controller.abort(); clearTimeout(timer); };
  }, [channelId, messageId, fetcher, key, owns, token]);
  return <div>
    <p className="app-connector-receipt-private" title={owns ? "Originals are available for 30 days while you can read this Channel." : undefined}><Lock aria-hidden="true" />
      {owns ? unavailable ? "Private result is unavailable" : value?.key === key ? "Private result · visible to you" : "Loading private result…"
        : "Private result · visible to the calling Agent and its owner"}
    </p>
    {owns && value?.key === key && <pre data-testid="private-connector-result"
      className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans text-sm [overflow-wrap:anywhere]">
      {value.detail}
    </pre>}
  </div>;
}
