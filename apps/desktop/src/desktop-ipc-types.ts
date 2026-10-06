import type { DesktopWorkspaceCandidateFields, DesktopAgentPresetDiscoveryShape } from "@xmatrix/protocol";
export type { DesktopUpdateState, DesktopUpdateStatus, DesktopDaemonState, DesktopDaemonStatus, DesktopSetupStatus, DesktopAgentPresetInput } from "@xmatrix/protocol";
/**
 * Shapes the main process and the preload bridge both carry across IPC; the
 * renderer sees them through `window.xmatrixDesktop`.
 */

export type DesktopWorkspaceCandidate = DesktopWorkspaceCandidateFields & { hostname: string };

export type DesktopAgentPresetDiscovery = DesktopAgentPresetDiscoveryShape<DesktopWorkspaceCandidate>;
