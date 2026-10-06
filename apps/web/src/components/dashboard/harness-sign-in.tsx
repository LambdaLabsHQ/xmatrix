"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, Loader2, LogIn } from "lucide-react";
import {
  MACHINE_HARNESS_LOGIN_CAPABILITY, agentPresetById, parseHarnessInventory,
  type AgentRegistrationSummary, type HarnessActionStatus, type HarnessLoginProgress,
} from "@xmatrix/protocol";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { noticeClass } from "@/components/ui/status-tone";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";

import { queueHarnessAction, readHarnessAction } from "./machine-harness-api";
import { ToolDetailSection } from "./tool-split";
import { fetchMachineDaemons } from "./workspace-admin-views";

type Step = "start" | "finish" | "cancel";
type Operation = { controlId: string; step: Step; startedAt: number };

const SETTLED = (status?: HarnessActionStatus["status"]) => Boolean(status && !["queued", "running"].includes(status));
const LOGIN_STATE_LABEL = { signed_in: "Signed in", signed_out: "Not signed in", unknown: "Could not check" } as const;

/** What the owner sees of a harness's own sign-in on one Machine, and the
 * steps that sign it in from here: the daemon runs the harness's official
 * sign-in, this shows its link and code, and hands back a pasted code. */
export function harnessSignInView(input: {
  registration: AgentRegistrationSummary; userId?: string;
  daemons?: readonly { userId: string; machineId?: string; hostId?: string; status: string; metadata: Record<string, unknown> }[];
}) {
  const { registration, userId } = input;
  const login = agentPresetById(registration.key.harness)?.management?.login;
  const owner = Boolean(userId && registration.key.ownerUserId === userId);
  const daemon = input.daemons?.find((item) => item.machineId === registration.key.machineId && item.status === "online");
  const capabilities = daemon?.metadata.capabilities;
  const capable = Array.isArray(capabilities) && capabilities.includes(MACHINE_HARNESS_LOGIN_CAPABILITY);
  const item = parseHarnessInventory(daemon?.metadata.harnesses)?.items.find((entry) => entry.id === registration.key.harness);
  return {
    visible: owner && Boolean(login),
    flow: login?.flow,
    state: item?.login,
    installed: item?.installed,
    daemon,
    blocker: !daemon ? "Connect this machine to sign in from here."
      : !capable ? "Update this machine's xMatrix daemon to sign in from here."
        : item && !item.installed ? "Install this harness on the machine first." : undefined,
  };
}

export function HarnessSignInSection({ registration, token, userId }: {
  registration: AgentRegistrationSummary; token: string; userId: string;
}) {
  const queryClient = useQueryClient();
  const daemonKey = useMemo(() => xmatrixQueryKeys.domain({ userId }, "machine-daemons", []), [userId]);
  const daemons = useQuery({ queryKey: daemonKey, queryFn: ({ signal }) => fetchMachineDaemons(token, signal),
    staleTime: 15_000, refetchInterval: 15_000, refetchIntervalInBackground: false });
  const view = harnessSignInView({ registration, userId, daemons: daemons.data });
  const [operation, setOperation] = useState<Operation | null>(null);
  const [prompt, setPrompt] = useState<HarnessLoginProgress | null>(null);
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  const status = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId }, "harness-actions", [operation?.controlId ?? null]),
    queryFn: ({ signal }) => readHarnessAction(token, operation!.controlId, signal),
    enabled: Boolean(operation), retry: false,
    refetchInterval: (query) => operation && Date.now() - operation.startedAt < 20 * 60_000 &&
      !SETTLED(query.state.data?.status) ? 2_000 : false,
    refetchIntervalInBackground: true,
  });

  const queue = useMutation({
    mutationFn: async (input: { step: Step; code?: string }) => {
      const daemon = view.daemon;
      if (!daemon?.machineId) throw new Error("This machine is offline.");
      const result = await queueHarnessAction(token, daemon.machineId, daemon.hostId, registration.key.harness,
        `login_${input.step}`, undefined, input.code);
      return { ...input, controlId: result.controlId };
    },
    onSuccess: ({ step, controlId }) => {
      setOperation({ controlId, step, startedAt: Date.now() });
      if (step !== "finish") setNotice(null);
    },
    onError: (error) => setNotice({ text: error instanceof Error ? error.message : "The sign-in could not be requested.", error: true }),
  });

  const settled = SETTLED(status.data?.status) ? status.data : undefined;
  useEffect(() => {
    if (!settled || !operation) return;
    const login = settled.result?.login;
    setOperation(null);
    if (operation.step === "start") {
      if (settled.status === "succeeded" && login?.state === "awaiting_user") {
        setPrompt(login);
        // A device code finishes on its own once the owner approves it there.
        if (login.flow === "device_code") queue.mutate({ step: "finish" });
      } else {
        setNotice({ text: settled.error ?? "The harness did not start its sign-in.", error: true });
      }
      return;
    }
    setCode("");
    if (operation.step === "finish" && login?.state === "awaiting_user") {
      // The harness refused the code and still waits for another one.
      setPrompt(login);
      setNotice({ text: settled.error ?? "The code was not accepted. Paste it again.", error: true });
      return;
    }
    setPrompt(null);
    if (operation.step === "cancel") return;
    if (settled.status === "succeeded" && login?.state === "signed_in") {
      setNotice({ text: "Signed in.", error: false });
    } else if (login?.state !== "cancelled") {
      setNotice({ text: settled.error ?? "The sign-in did not finish.", error: true });
    }
    void queryClient.invalidateQueries({ queryKey: daemonKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per settled operation
  }, [settled?.controlId]);

  if (!view.visible) return null;
  const busy = queue.isPending || Boolean(operation);
  const starting = busy && !prompt;
  const waitingForDevice = Boolean(prompt && prompt.flow === "device_code");

  return (
    <ToolDetailSection title="Sign-in">
      <div className="space-y-3 text-sm" data-testid="harness-sign-in">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p>
            {view.state ? LOGIN_STATE_LABEL[view.state] : "Not checked yet"}
            <span className="text-muted-foreground"> · the harness's own account on {registration.machineName}</span>
          </p>
          {!prompt && (
            <Button size="sm" variant="outline" disabled={busy || Boolean(view.blocker)}
              onClick={() => queue.mutate({ step: "start" })}>
              {starting ? <Loader2 className="animate-spin" /> : <LogIn />}
              {starting ? "Starting sign-in…" : view.state === "signed_in" ? "Sign in again" : "Sign in"}
            </Button>
          )}
        </div>
        {view.blocker && <p className="text-xs text-muted-foreground">{view.blocker}</p>}
        {prompt?.verificationUri && (
          <div className="space-y-2 rounded-lg border p-3">
            <p>
              Open this link{prompt.userCode ? " and enter the code" : ""}
              {prompt.flow === "url_paste_code" ? ", then paste the code the page shows below." : "."}
            </p>
            <a href={prompt.verificationUri} target="_blank" rel="noopener noreferrer"
              className="inline-flex max-w-full items-center gap-1 break-all font-semibold underline">
              <ExternalLink className="size-3.5 shrink-0" />{prompt.verificationUri}
            </a>
            {prompt.userCode && (
              <div className="flex items-center gap-2">
                <code className="rounded bg-muted px-2 py-1 text-base font-semibold tracking-widest" data-testid="harness-sign-in-code">
                  {prompt.userCode}
                </code>
                <Button size="sm" variant="ghost" aria-label="Copy code" onClick={() => {
                  void navigator.clipboard?.writeText(prompt.userCode!).then(() => setCopied(true));
                }}>
                  <Copy />{copied ? "Copied" : "Copy"}
                </Button>
              </div>
            )}
            {prompt.flow === "url_paste_code" && (
              <form className="flex gap-2" onSubmit={(event) => {
                event.preventDefault();
                if (code.trim()) queue.mutate({ step: "finish", code: code.trim() });
              }}>
                <Input value={code} onChange={(event) => setCode(event.target.value)} placeholder="Paste the code"
                  aria-label="Sign-in code" autoComplete="off" spellCheck={false} disabled={busy} />
                <Button size="sm" type="submit" disabled={busy || !code.trim()}>
                  {busy ? <Loader2 className="animate-spin" /> : null}Finish
                </Button>
              </form>
            )}
            <div className="flex items-center justify-between gap-2">
              {waitingForDevice && <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />Waiting for you to finish in the browser…
              </p>}
              <Button size="sm" variant="ghost" className="ml-auto"
                disabled={queue.isPending || operation?.step === "cancel"}
                onClick={() => queue.mutate({ step: "cancel" })}>Cancel</Button>
            </div>
          </div>
        )}
        {notice && <p role="status" className={noticeClass(notice.error ? "alert" : "settled", "rounded-lg p-3")}>{notice.text}</p>}
        {status.isError && <p className="text-xs text-destructive">Status could not be checked. The sign-in may still be running.</p>}
      </div>
    </ToolDetailSection>
  );
}
