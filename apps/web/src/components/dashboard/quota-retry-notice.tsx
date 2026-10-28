"use client";
import { useEffect, useRef, useState } from "react";
import { Clock } from "lucide-react";
import { WEB_PROXY_ROUTES, type AgentQuotaRetry } from "@xmatrix/protocol";
import { actionClass } from "@/components/ui/action-tone";
import { useOnboardingLocale } from "@/lib/onboarding-locale";
import { xmatrixRawResponse } from "@/lib/query/api-client";
import { ProblemCard } from "./problem-card";
/** Mounting only reads the offer. The author explicitly selects waiting;
 * the Hub's durable coordinator works even while every browser is closed. */
export function QuotaRetryNotice({
  id,
  channelId,
  body,
  spaceId,
  token,
  userId,
}: {
  id: string;
  channelId: string;
  body: string;
  spaceId: string | null;
  token: string | null;
  userId: string;
}) {
  const zh = useOnboardingLocale(spaceId, token, userId) === "zh";
  const [retry, setRetry] = useState<AgentQuotaRetry | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const version = useRef(0);
  const url = WEB_PROXY_ROUTES.channel_quota_retry(channelId, id);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const current = ++version.current;
      try {
        const response = await xmatrixRawResponse(url, {
          cache: "no-store",
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!response.ok) throw new Error("Could not read quota retry");
        const value = (await response.json()) as AgentQuotaRetry;
        if (disposed || current !== version.current) return;
        setRetry(value);
        if (["offered", "waiting", "dispatching"].includes(value.state) && Date.parse(value.expiresAt) > Date.now())
          timer = setTimeout(() => void read(), 30000);
      } catch {
        if (!disposed) setFailed(true);
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [token, url]);
  const choose = async (action: "wait" | "cancel") => {
    if (pending) return;
    version.current++;
    setPending(true);
    setFailed(false);
    try {
      const response = await xmatrixRawResponse(url, {
        method: "POST",
        cache: "no-store",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error("Could not change quota retry");
      setRetry((await response.json()) as AgentQuotaRetry);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  const state = retry?.state;
  const waiting = state === "waiting" || state === "dispatching";
  const labels = {
    offered: zh ? "是否在额度恢复后自动重试？" : "Retry automatically when quota recovers?",
    waiting: zh ? "已排队，等待供应商额度恢复" : "Queued, waiting for provider quota",
    dispatching: zh ? "正在重试" : "Retrying",
    dispatched: zh ? "已提交重试" : "Retry submitted",
    cancelled: zh ? "已取消等待" : "Waiting cancelled",
    expired: zh ? "等待已过期，请重新检查任务" : "Waiting expired. Check the task before retrying",
    failed: zh ? "自动重试未能启动，请查看详情" : "Automatic retry could not start. Check Details",
  };
  return (
    <ProblemCard
      icon={<Clock className="size-[18px]" />}
      title={zh ? "暂时没有 Agent 能接手" : "No Agent can take over right now"}
      explanation={
        zh
          ? "选择等待后，xMatrix 会在确认供应商额度恢复时重试。关闭网页也会保留，等待最多 35 天。"
          : "Choose to wait and xMatrix will retry once it confirms provider quota is available. You can close this page. Waiting lasts up to 35 days."
      }
      status={
        state
          ? {
              resolved: ["dispatched", "cancelled", "expired"].includes(state),
              label: labels[state],
            }
          : undefined
      }
      actions={
        <>
          {retry?.canChoose && state === "offered" && (
            <>
              <button
                type="button"
                className={actionClass({ variant: "primary", size: "sm" })}
                disabled={pending}
                onClick={() => void choose("wait")}
              >
                {zh ? "额度恢复后自动重试" : "Retry when quota recovers"}
              </button>
              <button
                type="button"
                className={actionClass({ variant: "secondary", size: "sm" })}
                disabled={pending}
                onClick={() => void choose("cancel")}
              >
                {zh ? "暂不重试" : "Not now"}
              </button>
            </>
          )}
          {retry?.canChoose && waiting && (
            <button
              type="button"
              className={actionClass({ variant: "secondary", size: "sm" })}
              disabled={pending}
              onClick={() => void choose("cancel")}
            >
              {zh ? "取消等待" : "Cancel waiting"}
            </button>
          )}
          {failed && (
            <span role="status" className="text-sm text-destructive">
              {zh ? "无法确认当前状态，请刷新后重试。" : "Couldn't confirm the current state. Refresh and try again."}
            </span>
          )}
        </>
      }
      detailsLabel={zh ? "详情" : "Details"}
      details={<pre className="whitespace-pre-wrap break-words text-xs">{[body,retry?.failureMessage].filter(Boolean).join("\n\n")}</pre>}
    />
  );
}
