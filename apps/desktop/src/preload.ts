import type { DesktopNotification, DesktopBadgeState, DesktopNotificationReply, DesktopClipboardImage } from "@xmatrix/protocol";
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopCliSessionPayload } from "./cli-session";
import type {
  DesktopAgentPresetDiscovery,
  DesktopAgentPresetInput,
  DesktopDaemonStatus,
  DesktopSetupStatus,
  DesktopUpdateStatus,
} from "./desktop-ipc-types";

type DesktopLocalProfile = {
  id: string;
  name: string;
  hubUrl: string;
  stateRoot: string;
  revision: number;
};

type DesktopLocalProfileSelection =
  | { mode: "follow-default"; profile?: DesktopLocalProfile | null }
  | { mode: "explicit"; profileId: string; profile?: DesktopLocalProfile | null };

type DesktopDefaultProfileChanged = {
  revision: number;
  profileId: string;
  name: string;
  hubUrl: string;
  followedByWindow: boolean;
};

contextBridge.exposeInMainWorld("xmatrixDesktop", {
  client: "desktop",
  platform: process.platform,
  getContext: () => ipcRenderer.invoke("desktop:get-context"),
  setBadge: (state: DesktopBadgeState) => ipcRenderer.invoke("desktop:set-badge", state),
  setTitle: (title: string) => ipcRenderer.invoke("desktop:set-title", title),
  openWindow: (path?: string) => ipcRenderer.invoke("desktop:open-window", path),
  getNotificationSettings: () => ipcRenderer.invoke("desktop:get-notification-settings"),
  requestNotifications: () => ipcRenderer.invoke("desktop:request-notifications"),
  notify: (payload: DesktopNotification) => ipcRenderer.invoke("desktop:notify", payload),
  openExternal: (url: string) => ipcRenderer.invoke("desktop:open-external", url),
  writeClipboardImage: (image: DesktopClipboardImage) =>
    ipcRenderer.invoke("desktop:write-clipboard-image", image),
  checkCliInstalled: () => ipcRenderer.invoke("desktop:check-cli-installed"),
  saveCliSession: (payload: DesktopCliSessionPayload) =>
    ipcRenderer.invoke("desktop:save-cli-session", payload),
  refreshCliSession: (payload: DesktopCliSessionPayload) =>
    ipcRenderer.invoke("desktop:refresh-cli-session", payload),
  switchEnvironment: (environment: "production" | "test") =>
    ipcRenderer.invoke("desktop:switch-environment", environment),
  getLocalProfile: (): Promise<DesktopLocalProfileSelection> =>
    ipcRenderer.invoke("desktop:get-local-profile"),
  setLocalProfile: (selection: { mode: "follow-default" } | { mode: "explicit"; profileId: string }) =>
    ipcRenderer.invoke("desktop:set-local-profile", selection),
  openCliInstall: () => ipcRenderer.invoke("desktop:open-cli-install"),
  installCli: () => ipcRenderer.invoke("desktop:install-cli"),
  getDaemonStatus: () => ipcRenderer.invoke("desktop:get-daemon-status"),
  startDaemon: () => ipcRenderer.invoke("desktop:start-daemon"),
  stopDaemon: () => ipcRenderer.invoke("desktop:stop-daemon"),
  restartDaemon: () => ipcRenderer.invoke("desktop:restart-daemon"),
  getSetupStatus: () => ipcRenderer.invoke("desktop:get-setup-status"),
  saveSetupStatus: (status: DesktopSetupStatus) =>
    ipcRenderer.invoke("desktop:save-setup-status", status),
  chooseWorkspaceDirectory: () => ipcRenderer.invoke("desktop:choose-workspace-directory"),
  validateWorkspacePath: (workspacePath: string) =>
    ipcRenderer.invoke("desktop:validate-workspace-path", workspacePath),
  installAgentPreset: (presetId: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("desktop:install-agent-preset", presetId),
  discoverAgentPresets: (presets: DesktopAgentPresetInput[]): Promise<DesktopAgentPresetDiscovery[]> =>
    ipcRenderer.invoke("desktop:discover-agent-presets", presets),
  revealPath: (workspacePath: string) => ipcRenderer.invoke("desktop:reveal-path", workspacePath),
  checkRuntime: (runtime: string) => ipcRenderer.invoke("desktop:check-runtime", runtime),
  checkForUpdates: () => ipcRenderer.invoke("desktop:check-for-updates"),
  getUpdateStatus: () => ipcRenderer.invoke("desktop:get-update-status"),
  installUpdate: () => ipcRenderer.invoke("desktop:install-update"),
  showUpdateNotification: (payload?: DesktopNotification) =>
    ipcRenderer.invoke("desktop:show-update-notification", payload),
  onUpdateStatus: (listener: (status: DesktopUpdateStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: DesktopUpdateStatus) => {
      listener(status);
    };
    ipcRenderer.on("desktop:update-status", handler);
    return () => {
      ipcRenderer.removeListener("desktop:update-status", handler);
    };
  },
  getFullScreen: (): Promise<boolean> => ipcRenderer.invoke("desktop:get-full-screen"),
  onFullScreenChange: (listener: (fullScreen: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, fullScreen: boolean) => {
      listener(fullScreen);
    };
    ipcRenderer.on("desktop:full-screen-changed", handler);
    return () => {
      ipcRenderer.removeListener("desktop:full-screen-changed", handler);
    };
  },
  onDaemonStatus: (listener: (status: DesktopDaemonStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: DesktopDaemonStatus) => {
      listener(status);
    };
    ipcRenderer.on("desktop:daemon-status", handler);
    return () => {
      ipcRenderer.removeListener("desktop:daemon-status", handler);
    };
  },
  onDefaultProfileChanged: (listener: (event: DesktopDefaultProfileChanged) => void) => {
    let lastRevision = 0;
    const handler = (_event: Electron.IpcRendererEvent, event: DesktopDefaultProfileChanged) => {
      if (!Number.isSafeInteger(event.revision) || event.revision <= lastRevision) return;
      lastRevision = event.revision;
      listener(event);
    };
    ipcRenderer.on("desktop:default-profile-changed", handler);
    return () => {
      ipcRenderer.removeListener("desktop:default-profile-changed", handler);
    };
  },
  onLocalProfileSelectionChanged: (listener: (selection: DesktopLocalProfileSelection) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, selection: DesktopLocalProfileSelection) => {
      listener(selection);
    };
    ipcRenderer.on("desktop:local-profile-selection-changed", handler);
    return () => {
      ipcRenderer.removeListener("desktop:local-profile-selection-changed", handler);
    };
  },
  onNotificationReply: (listener: (reply: DesktopNotificationReply) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, reply: DesktopNotificationReply) => {
      listener(reply);
    };
    ipcRenderer.on("desktop:notification-reply", handler);
    return () => {
      ipcRenderer.removeListener("desktop:notification-reply", handler);
    };
  },
});
