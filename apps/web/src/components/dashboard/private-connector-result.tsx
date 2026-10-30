"use client";

import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import type { Components } from "react-markdown";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";
import { parseGmailMessage } from "@/lib/gmail-message";
import { GmailMessageCard } from "./gmail-message-card";
import { splitConnectorResult } from "@/lib/connector-result";
import { ConnectorResultLinkAction } from "./connector-result-link";
import { messageMarkdownComponents, RichMessageContent } from "./workspace-shell-rich-message";
import { isSafeRichTextHref } from "./workspace-shell-formatters";

/** Its Markdown is drawn like a message's, but nothing in it loads media from a host the result names. */
const PRIVATE_RESULT_COMPONENTS: Components = {
  ...messageMarkdownComponents,
  img: () => null,
  a: ({ href, children }) => typeof href === "string" && isSafeRichTextHref(href)
    ? <a href={href} target="_blank" rel="noreferrer" className="font-medium text-primary underline underline-offset-2">{children}</a>
    : <>{children}</>,
};

/** Private values never enter the shared message model, quote/selection actions or Markdown media. */
export function PrivateConnectorResult({ channelId, messageId, ownerUserId, ownerName, token, compact = false }: {
  channelId: string; messageId: string; ownerUserId: string; token: string | null;
  /** Who else may read it, when the reader knows them by name. */
  ownerName?: string;
  /** One line of a list: the original as plain text, then who can see it. */
  compact?: boolean;
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
  const detail = owns && value?.key === key ? value.detail : undefined;
  const email = detail === undefined ? undefined : parseGmailMessage(detail);
  const result = detail === undefined || email ? undefined : splitConnectorResult(detail);
  if (compact) return <>
    {detail !== undefined ? <span className="block whitespace-pre-wrap" data-testid="private-connector-result">
      {email ? `${email.subject || "(no subject)"} — ${email.fromName || email.fromAddress}` : detail}</span>
      : owns ? <span className="block">{unavailable ? "Private result is unavailable" : "Loading private result…"}</span> : null}
    <span className="flex items-center gap-1 text-[12px]"><Lock aria-hidden="true" className="size-3" />
      {owns ? "Only you can see this result" : `Only ${ownerName ?? "its owner"} can see this result`}</span>
  </>;
  return <div>
    {email && <div data-testid="private-connector-result"><GmailMessageCard message={email} /></div>}
    {/* Once the original is shown, the header's lock says who can see it; only a missing original needs words. */}
    {detail === undefined && <p className="app-connector-receipt-private"><Lock aria-hidden="true" />
      {owns ? unavailable ? "Private result is unavailable" : "Loading private result…"
        : `Private result · visible to ${ownerName ?? "its owner"} and the Agent that ran it`}
    </p>}
    {result && <div className="app-connector-receipt-detail">
      <div data-testid="private-connector-result" className="max-h-80 overflow-auto [overflow-wrap:anywhere]">
        <RichMessageContent body={result.body} components={PRIVATE_RESULT_COMPONENTS} />
      </div>
      {result.link && <ConnectorResultLinkAction link={result.link} />}
    </div>}
  </div>;
}
