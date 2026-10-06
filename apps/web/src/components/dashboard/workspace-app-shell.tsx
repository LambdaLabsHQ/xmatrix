"use client";

import type { ReactNode } from "react";
import { useWorkspaceShellState } from "./use-workspace-shell-state";
import { useWorkspaceShellActions } from "./use-workspace-shell-actions";
import { WorkspaceShellView } from "./workspace-shell-view";

export * from "./workspace-shell-modules";

export default function WorkspaceAppShell({ children }: { children?: ReactNode }) {
  const state = useWorkspaceShellState({ children });
  const model = useWorkspaceShellActions(state);
  return <WorkspaceShellView model={model} />;
}
