"use client";

import { useState, type ReactNode } from "react";
import { isPlaceholderHumanName } from "@xmatrix/protocol";
import { NameYourselfStep } from "@/components/auth/name-yourself-step";
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
  if (user && session && !named && isPlaceholderHumanName(user.name, user.id)) {
    return <NameYourselfStep token={session.access_token} onNamed={() => setNamed(true)} />;
  }
  return <WorkspaceShell>{children}</WorkspaceShell>;
}

function WorkspaceShell({ children }: { children?: ReactNode }) {
  const state = useWorkspaceShellState({ children });
  const model = useWorkspaceShellActions(state);
  return <WorkspaceShellView model={model} />;
}
