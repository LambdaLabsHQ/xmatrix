"use client";

import { useSyncExternalStore } from "react";
import { WEB_PROXY_ROUTES, type AgentAccessGrant, type AgentRegistrationEnvironment } from "@xmatrix/protocol";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { CenteredDialogShell, DialogButton, DialogPanelFooter, DialogPanelHeader } from "./centered-dialog-shell";

/* What an Agent may do on a machine is its owner's to confirm, when the Agent
   is added. Every add path asks through this one dialog, and what it shows is
   the grant the Hub resolves for the launch (`AgentAccessGrant`): the same data
   the daemon applies. */

/** A machine owner's harness environment as the Hub reads it back, with what
 * full access adds to that harness's launch. */
type AgentEnvironmentState = {
  key: { ownerUserId: string; machineId: string; harness: string };
  version: number;
  environment: AgentRegistrationEnvironment | null;
  /** Absent from a Hub that does not report it. */
  fullAccess?: AgentAccessGrant;
};

function readAgentEnvironment(token: string, key: AgentEnvironmentState["key"]): Promise<AgentEnvironmentState> {
  return xmatrixApiRequest<AgentEnvironmentState>({ url: WEB_PROXY_ROUTES.agent_environment_query, token, method: "POST",
    body: { ownerUserId: key.ownerUserId, machineId: key.machineId, harness: key.harness } });
}

/** Everything the grant adds, one line each, in the words it is written in. */
function agentAccessLines(grant: AgentAccessGrant, name: string): Array<{ text: string; written?: string }> {
  const lines: Array<{ text: string; written?: string }> = [
    ...grant.args.map((written) => ({ text: "Adds the argument", written })),
    ...Object.entries(grant.env).map(([key, value]) => ({ text: "Sets the environment variable", written: `${key}=${value}` })),
    ...Object.entries(grant.session).map(([key, value]) => ({ text: "Starts each session with", written: `${key}=${value}` })),
  ];
  // A harness xMatrix passes nothing to is said to get nothing, not left blank.
  if (!lines.length) lines.push({ text: "Adds no argument or environment variable to its launch" });
  if (grant.approvesRequests) lines.push({ text: `Answers every permission request ${name} makes with allow` });
  return lines;
}

export function AgentAccessLines({ grant, name }: { grant: AgentAccessGrant; name: string }) {
  return (
    <ul className="space-y-1" data-testid="agent-access-lines">
      {agentAccessLines(grant, name).map((line) => (
        <li key={`${line.text}:${line.written ?? ""}`} className="min-w-0 break-words">
          {line.text}{line.written && <> <code className="font-mono text-[0.92em] font-semibold">{line.written}</code></>}
        </li>
      ))}
    </ul>
  );
}

export const FULL_ACCESS_EFFECT = "It then works without asking before it changes a file or runs a command, and xMatrix sets no limit on which files it reaches.";

type AccessQuestion = { items: Array<{ name: string; grant: AgentAccessGrant }>; confirm: string; answer: (agreed: boolean) => void };

let question: AccessQuestion | null = null;
const hosts = new Set<() => void>();
const publish = (next: AccessQuestion | null) => { question = next; for (const host of hosts) host(); };
const subscribe = (host: () => void) => { hosts.add(host); return () => { hosts.delete(host); }; };

/** Shows what full access adds for each harness and resolves with the owner's
 * answer. With no dialog mounted to ask in, nothing was confirmed. */
function askAgentAccess(items: AccessQuestion["items"], confirm: string): Promise<boolean> {
  if (!hosts.size || question) return Promise.resolve(false);
  return new Promise((resolve) => publish({ items, confirm, answer: (agreed) => { publish(null); resolve(agreed); } }));
}

/**
 * The access mode each add confirms, by harness. A harness whose owner already
 * confirmed a mode on this machine is absent: its add writes none. Null when
 * the owner declined, and nothing is to be added.
 */
export async function confirmAccessForAdd(token: string, adds: ReadonlyArray<{
  key: AgentEnvironmentState["key"]; name: string }>, confirm?: string): Promise<Map<string, "full"> | null> {
  const held = await Promise.all(adds.map((add) => readAgentEnvironment(token, add.key)));
  const unconfirmed = adds.flatMap((add, index) => {
    const state = held[index]!;
    return state.environment?.launch?.access || !state.fullAccess ? [] : [{ harness: add.key.harness, name: add.name, grant: state.fullAccess }];
  });
  if (unconfirmed.length && !(await askAgentAccess(unconfirmed, confirm ??
    (unconfirmed.length === 1 ? "Add with full access" : `Add ${unconfirmed.length} with full access`)))) return null;
  return new Map(unconfirmed.map((item) => [item.harness, "full" as const]));
}

/** Mounted once by the workspace shell: the one place an access question is asked. */
export function AgentAccessConfirmationHost() {
  const asked = useSyncExternalStore(subscribe, () => question, () => null);
  if (!asked) return null;
  const single = asked.items.length === 1 ? asked.items[0]! : null;
  return (
    <CenteredDialogShell open busy={false} labelledBy="agent-access-title" onCancel={() => asked.answer(false)} panelClassName="max-w-md">
      <DialogPanelHeader labelledBy="agent-access-title"
        title={single ? `${single.name}: full access on this machine?` : "Full access on this machine?"} />
      <div className="max-h-[60dvh] space-y-3 overflow-y-auto px-5 py-4 text-sm" data-testid="agent-access-confirmation">
        {asked.items.map((item) => (
          <section key={item.name} className="space-y-1.5">
            <p className="font-semibold">xMatrix starts {item.name} like this:</p>
            <AgentAccessLines grant={item.grant} name={item.name} />
          </section>
        ))}
        <p className="text-muted-foreground">{single ? FULL_ACCESS_EFFECT : FULL_ACCESS_EFFECT.replace("It then works", "Each then works")}</p>
      </div>
      <DialogPanelFooter>
        <DialogButton onClick={() => asked.answer(false)}>Cancel</DialogButton>
        <DialogButton tone="primary" onClick={() => asked.answer(true)}>{asked.confirm}</DialogButton>
      </DialogPanelFooter>
    </CenteredDialogShell>
  );
}
