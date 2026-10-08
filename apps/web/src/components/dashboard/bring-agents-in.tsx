"use client";

import { useState } from "react";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import { actionClass } from "@/components/ui/action-tone";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { cn } from "@/lib/utils";
import { useNow } from "./agent-work-intent";
import {
  connectStep, defaultInstallPlatform, listNames, setupInstallCommand,
  type ConnectStep, type InstallPlatform,
} from "./connect-machine";
import { useSetupIntent } from "./use-setup-intent";

/* Where agents come from: a machine of the reader's own. The desktop app
   connects the computer it runs on by itself; any other machine is connected
   with one command, and this page then shows what happens to it, live. The
   Space's empty screen, an empty Agents page and Machines' "Connect a machine"
   all show this one flow. */

const RUNTIME_INSTALL_HINT = "curl -fsSL https://claude.ai/install.sh | bash";

export function BringAgentsIn({ spaceId, token, userId, centered = false }: {
  spaceId: string | null; token: string | undefined; userId: string | undefined; centered?: boolean;
}) {
  return (
    <div className={cn(centered && "text-center")}>
      <a href="/download" className={actionClass({ variant: "primary", size: "md" }, "mt-4")}>
        <Download className="size-4" />
        Download xMatrix
      </a>
      <ConnectMachine spaceId={spaceId} token={token} userId={userId} centered={centered} />
    </div>
  );
}

/* One command for the machine, then what happened to it, as it happens: the
   terminal asking to be approved, the machine coming online, the agents it
   has, and one click to bring them into this Space. */
export function ConnectMachine({ spaceId, token, userId, centered = false }: {
  spaceId: string | null; token: string | undefined; userId: string | undefined; centered?: boolean;
}) {
  const intent = useSetupIntent(spaceId, token, userId);
  const [platform, setPlatform] = useState<InstallPlatform>(() =>
    typeof navigator === "undefined" ? "unix" : defaultInstallPlatform(navigator.userAgent));
  const now = useNow(1_000);
  const command = intent.intentId ? setupInstallCommand(intent.intentId, platform) : null;
  const { copied, copy } = useCopyToClipboard(command ?? "");
  const step = intent.status ? connectStep(intent.status, now - intent.shownAt) : null;
  return (
    <div className="mt-5" data-testid="connect-machine">
      <p className="text-sm text-muted-foreground">Or run this on the computer your agents use:</p>
      <div className={cn("mt-2 flex min-w-0 flex-wrap items-center gap-2", centered && "justify-center")}>
        <code className="min-w-0 rounded bg-muted px-2 py-1 text-left font-mono text-xs [overflow-wrap:anywhere]">
          {command ?? "Preparing a command…"}
        </code>
        <button type="button" disabled={!command} onClick={() => void copy()}
          className={actionClass({ variant: "secondary", size: "sm" })}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <button type="button" onClick={() => setPlatform(platform === "windows" ? "unix" : "windows")}
        className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
        {platform === "windows" ? "On macOS or Linux?" : "On Windows?"}
      </button>
      {step && <ConnectStepLine step={step} busy={intent.busy} centered={centered}
        onApprove={(code) => void intent.approve(code)} onDecline={() => void intent.decline()}
        onBringIn={(ids) => void intent.bringIn(ids)} />}
      {intent.error && <p role="alert" className="mt-2 text-sm text-destructive">{intent.error}</p>}
    </div>
  );
}

function ConnectStepLine({ step, busy, centered, onApprove, onDecline, onBringIn }: {
  step: ConnectStep; busy: boolean; centered: boolean;
  onApprove: (userCode: string) => void; onDecline: () => void; onBringIn: (harnessIds: string[]) => void;
}) {
  const line = cn("flex min-w-0 flex-wrap items-center gap-2", centered && "justify-center");
  const row = cn("mt-3 text-sm", line);
  const waiting = <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />;
  const done = <Check className="size-4 shrink-0 text-primary" />;
  switch (step.kind) {
    case "waiting":
      return (
        <div role="status" className="mt-3 text-sm text-muted-foreground">
          <p className={line}>{waiting} Waiting for the command…</p>
          {step.hint === "check-terminal" && <p className="mt-1">Nothing yet? The terminal says what went wrong.</p>}
          {step.hint === "try-desktop" && <p className="mt-1">Still nothing? The desktop app connects without a terminal.</p>}
        </div>
      );
    case "approval":
      return (
        <div role="status" className={row}>
          <span><strong>{step.hostname}</strong> wants to connect with code{" "}
            <code className="font-mono font-semibold">{step.userCode}</code>.
            Approve it only if the terminal shows the same code.</span>
          <button type="button" disabled={busy} onClick={() => onApprove(step.userCode)}
            className={actionClass({ variant: "primary", size: "sm" })}>Approve</button>
          <button type="button" disabled={busy} onClick={onDecline}
            className={actionClass({ variant: "quiet", size: "sm" })}>Not mine</button>
        </div>
      );
    case "connecting":
      return <p role="status" className={row}>{waiting} {step.hostname} is signing in…</p>;
    case "looking":
      return <p role="status" className={row}>{done} {step.machineName} is connected. Looking for agents…</p>;
    case "found":
      return (
        <div role="status" className={row}>
          {done}
          <span>{step.machineName} is connected. Found {listNames(step.harnesses.map((harness) => harness.name))}.</span>
          <button type="button" disabled={busy} onClick={() => onBringIn(step.harnesses.map((harness) => harness.id))}
            className={actionClass({ variant: "primary", size: "sm" })}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {step.harnesses.length === 1 ? "Bring it in" : "Bring them in"}
          </button>
        </div>
      );
    case "none-installed":
      return (
        <div role="status" className="mt-3 text-sm">
          <p className={line}>{done} {step.machineName} is connected, but no agent is installed there yet.</p>
          <p className="mt-1 text-muted-foreground">
            Install one there, for example <code className="font-mono text-xs">{RUNTIME_INSTALL_HINT}</code>
          </p>
        </div>
      );
    case "done":
      return <p role="status" className={row}>{done} Your agents on {step.machineName} are in this Space.</p>;
  }
}
