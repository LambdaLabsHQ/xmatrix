"use client";

import { useEffect, useState, type ReactNode } from "react";
import { isPlaceholderHumanName } from "@xmatrix/protocol";
import { NameYourselfStep } from "@/components/auth/name-yourself-step";
import { NEW_ACCOUNT_FLAG, NewAccountStep } from "@/components/auth/new-account-step";
import { useAuth } from "@/lib/auth-context";
import { useWorkspaceShellState } from "./use-workspace-shell-state";
import { useWorkspaceShellActions } from "./use-workspace-shell-actions";
import { WorkspaceShellView } from "./workspace-shell-view";

export * from "./workspace-shell-modules";

/* An account without a name it chose names itself before the app opens, so
   agents can address it and its first Space is not named after an id. */
export default function WorkspaceAppShell({ children }: { children?: ReactNode }) {
  const { user, session } = useAuth();
  const [named, setNamed] = useState(false);
  const [newAccount, setNewAccount] = useState(false);
  useEffect(() => setNewAccount(new URLSearchParams(window.location.search).has(NEW_ACCOUNT_FLAG)), []);
  if (user && session && !named && isPlaceholderHumanName(user.name, user.id)) {
    return <NameYourselfStep token={session.access_token} email={user.email} onNamed={() => setNamed(true)} />;
  }
  if (user && newAccount) {
    return <NewAccountStep email={user.email} onContinue={() => {
      const url = new URL(window.location.href);
      url.searchParams.delete(NEW_ACCOUNT_FLAG);
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      setNewAccount(false);
    }} />;
  }
  return <WorkspaceShell>{children}</WorkspaceShell>;
}

function WorkspaceShell({ children }: { children?: ReactNode }) {
  const state = useWorkspaceShellState({ children });
  const model = useWorkspaceShellActions(state);
  return <WorkspaceShellView model={model} />;
}
