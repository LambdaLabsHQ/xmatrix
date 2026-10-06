/**
 * The operating system a Machine reports. Daemons send `metadata.platform` as
 * `windows` / `macos` / `linux`; the desktop bridge reports Node's `win32` /
 * `darwin` / `linux`. An older daemon that reported none is unknown.
 */
export type MachineOs = "windows" | "macos" | "linux" | "unknown";

export function machineOs(platform: string | undefined): MachineOs {
  if (platform === "windows" || platform === "win32") return "windows";
  if (platform === "macos" || platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "unknown";
}
