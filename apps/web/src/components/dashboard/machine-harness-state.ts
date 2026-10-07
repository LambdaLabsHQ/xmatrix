import { AGENT_PRESETS, MACHINE_HARNESS_CURSOR_LAUNCHER_CAPABILITY, MACHINE_HARNESS_UNINSTALL_CAPABILITY, parseHarnessInventory, compareClientVersions, harnessActionAvailable, type HarnessCommand, type SerializedMachineDaemon } from "@xmatrix/protocol";

export function harnessUpdateAvailable(current?: string, latest?: string): boolean {
  return Boolean(current && latest && compareClientVersions(current, latest) === -1);
}

export function machineHarnessState(daemon: SerializedMachineDaemon | undefined, userId?: string) {
  const inventory = parseHarnessInventory(daemon?.metadata.harnesses);
  const platform = daemon?.metadata.platform;
  const recipePlatform: "windows" | "unix" | undefined = platform === "windows" ? "windows"
    : platform === "linux" || platform === "macos" ? "unix" : undefined;
  const capabilities = daemon?.metadata.capabilities;
  // Hub keeps a daemon "online" until a connection event says otherwise; work it
  // left unanswered is evidence an action may not reach it now. That is a
  // warning, not a lock: the evidence is heuristic and a retry may be delivered.
  const responding = !daemon?.unansweredSince;
  const canManage = Boolean(daemon && daemon.userId === userId && daemon.machineId &&
    daemon.status === "online" && Array.isArray(capabilities) &&
    capabilities.includes("machine_harness_action_v1"));
  const cursorUpdateReady = Array.isArray(capabilities) && capabilities.includes(MACHINE_HARNESS_CURSOR_LAUNCHER_CAPABILITY);
  const uninstallReady = Array.isArray(capabilities) && capabilities.includes(MACHINE_HARNESS_UNINSTALL_CAPABILITY);
  const catalog = AGENT_PRESETS.filter((preset) => preset.id !== "custom").map((preset) => ({
    preset, item: inventory?.items.find((item) => item.id === preset.id),
  }));
  const installed = catalog.filter((row) => row.item?.installed);
  return { inventory, recipePlatform, canManage, responding, cursorUpdateReady, uninstallReady,
    rows: [...installed, ...catalog.filter((row) => !row.item?.installed)] };
}

/** Display argv as documentation; this text is never sent for execution. */
export function harnessCommandLabel(recipe: HarnessCommand | null | undefined): string | undefined {
  return recipe ? [recipe.command, ...recipe.args.map((arg) => /\s|["'`]/u.test(arg) ? JSON.stringify(arg) : arg)].join(" ") : undefined;
}

export function harnessAutoUpdateSupported(preset: typeof AGENT_PRESETS[number]): boolean {
  return harnessActionAvailable(preset.management, "auto_update_on");
}
