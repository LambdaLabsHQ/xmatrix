"use client";

import { useState, useSyncExternalStore } from "react";
import { WEB_PROXY_ROUTES, type AgentAccessGrant, type AgentAccessMode, type AgentRegistrationEnvironment } from "@xmatrix/protocol";
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
  /** The modes this harness can be given; absent means `full` alone. */
  accessModes?: AgentAccessMode[];
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
export const ASK_ACCESS_EFFECT = "xMatrix adds none of that. It runs on its own defaults, and each time it wants permission for a file or a command it asks in the Channel it is working in and waits. Plain xmatrix commands are not asked about.";

type AccessItem = { harness: string; name: string; grant: AgentAccessGrant; modes: AgentAccessMode[]; mode: AgentAccessMode };
type AccessQuestion = { items: AccessItem[]; verb: "Add" | "Confirm"; answer: (chosen: Map<string, AgentAccessMode> | null) => void };

let question: AccessQuestion | null = null;
const hosts = new Set<() => void>();
const publish = (next: AccessQuestion | null) => { question = next; for (const host of hosts) host(); };
const subscribe = (host: () => void) => { hosts.add(host); return () => { hosts.delete(host); }; };

/** Shows what each mode means for each harness and resolves with the mode its
 * owner chose for each. With no dialog mounted to ask in, nothing was confirmed. */
function askAgentAccess(items: AccessItem[], verb: AccessQuestion["verb"]): Promise<Map<string, AgentAccessMode> | null> {
  if (!hosts.size || question) return Promise.resolve(null);
  return new Promise((resolve) => publish({ items, verb, answer: (chosen) => { publish(null); resolve(chosen); } }));
}

const accessItem = (state: AgentEnvironmentState, name: string): AccessItem | null => state.fullAccess ? {
  harness: state.key.harness, name, grant: state.fullAccess, modes: state.accessModes ?? ["full"],
  mode: state.environment?.launch?.access ?? "full" } : null;

/**
 * The access mode each add confirms, by harness. A harness whose owner already
 * confirmed a mode on this machine is absent: its add writes none. Null when
 * the owner declined, and nothing is to be added.
 */
export async function confirmAccessForAdd(token: string, adds: ReadonlyArray<{
  key: AgentEnvironmentState["key"]; name: string }>): Promise<Map<string, AgentAccessMode> | null> {
  const held = await Promise.all(adds.map((add) => readAgentEnvironment(token, add.key)));
  const unconfirmed = adds.flatMap((add, index) => {
    const state = held[index]!, item = accessItem({ ...state, key: add.key }, add.name);
    return state.environment?.launch?.access || !item ? [] : [item];
  });
  return unconfirmed.length ? askAgentAccess(unconfirmed, "Add") : new Map();
}

/** The mode a machine's owner picks for a harness already added there: the one
 * it holds is preselected. Null when they left it as it is. */
export async function chooseHeldAccess(token: string, key: AgentEnvironmentState["key"], name: string): Promise<AgentAccessMode | null> {
  const item = accessItem({ ...await readAgentEnvironment(token, key), key }, name);
  return item ? (await askAgentAccess([item], "Confirm"))?.get(key.harness) ?? null : null;
}

function AccessQuestionDialog({ asked }: { asked: AccessQuestion }) {
  const [modes, setModes] = useState(() => new Map(asked.items.map((item) => [item.harness, item.mode])));
  const single = asked.items.length === 1 ? asked.items[0]! : null;
  const allFull = asked.items.every((item) => modes.get(item.harness) === "full");
  const confirm = single
    ? modes.get(single.harness) === "full" ? `${asked.verb} with full access` : `${asked.verb}, asking first`
    : allFull ? `${asked.verb} ${asked.items.length} with full access` : `${asked.verb} ${asked.items.length}`;
  return (
    <CenteredDialogShell open busy={false} labelledBy="agent-access-title" onCancel={() => asked.answer(null)} panelClassName="max-w-md">
      <DialogPanelHeader labelledBy="agent-access-title"
        title={single ? single.modes.length > 1 ? `${single.name}: access on this machine` : `${single.name}: full access on this machine?`
          : "Full access on this machine?"} />
      <div className="max-h-[60dvh] space-y-4 overflow-y-auto px-5 py-4 text-sm" data-testid="agent-access-confirmation">
        {asked.items.map((item) => {
          const mode = modes.get(item.harness) ?? "full";
          return (
            <section key={item.harness} className="space-y-1.5">
              <p className="font-semibold">With full access, xMatrix starts {item.name} like this:</p>
              <AgentAccessLines grant={item.grant} name={item.name} />
              <p className="text-muted-foreground">{FULL_ACCESS_EFFECT}</p>
              {item.modes.includes("ask") && (
                <fieldset className="space-y-1 pt-1">
                  <legend className="sr-only">Access for {item.name}</legend>
                  {(["full", "ask"] as const).map((choice) => (
                    <label key={choice} className="flex cursor-pointer items-start gap-2">
                      <input type="radio" className="mt-1" name={`agent-access-${item.harness}`} checked={mode === choice}
                        onChange={() => setModes((current) => new Map(current).set(item.harness, choice))} />
                      <span><span className="font-semibold">{choice === "full" ? "Full access" : "Ask first"}</span>
                        {choice === "ask" && <span className="block text-muted-foreground">{ASK_ACCESS_EFFECT}</span>}</span>
                    </label>
                  ))}
                </fieldset>
              )}
            </section>
          );
        })}
      </div>
      <DialogPanelFooter>
        <DialogButton onClick={() => asked.answer(null)}>Cancel</DialogButton>
        <DialogButton tone="primary" onClick={() => asked.answer(modes)}>{confirm}</DialogButton>
      </DialogPanelFooter>
    </CenteredDialogShell>
  );
}

/** Mounted once by the workspace shell: the one place an access question is asked. */
export function AgentAccessConfirmationHost() {
  const asked = useSyncExternalStore(subscribe, () => question, () => null);
  return asked ? <AccessQuestionDialog key={asked.items.map((item) => item.harness).join(":")} asked={asked} /> : null;
}
