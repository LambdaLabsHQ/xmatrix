import { execFile, spawn } from "node:child_process";

// Native-owned allowlist. Renderer strings, runtime commands and install hints
// never become shell input. Installation does not register or authenticate an agent.
const packages: Readonly<Record<string, readonly string[]>> = {
  codex: ["@openai/codex"],
  opencode: ["opencode-ai"],
  pi: ["@earendil-works/pi-coding-agent", "pi-acp"],
  copilot: ["@github/copilot"],
  gemini: ["@google/gemini-cli"],
  qwen: ["@qwen-code/qwen-code"],
  junie: ["@jetbrains/junie"],
  openclaw: ["openclaw"],
};

export function agentPresetInstallCommand(presetId: unknown, platform: string) {
  if (typeof presetId !== "string" || !Object.hasOwn(packages, presetId)) {
    throw new Error("This runtime has no supported one-click installer");
  }
  const args = ["install", "--global", "--no-audit", "--no-fund", ...packages[presetId]!];
  return platform === "win32"
    ? { file: "cmd.exe", args: ["/d", "/s", "/c", `npm ${args.join(" ")}`] }
    : { file: "npm", args };
}

let installing = false;
export async function installAgentPreset(presetId: unknown, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; message: string }> {
  if (installing) return { ok: false, message: "An installation is already running" };
  let command;
  try { command = agentPresetInstallCommand(presetId, process.platform); }
  catch { return { ok: false, message: "This runtime has no supported one-click installer" }; }
  installing = true;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.file, command.args, { env, windowsHide: true,
        detached: process.platform !== "win32", stdio: "ignore" });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (!child.pid) { child.kill(); return; }
        // Kill the package manager's entire child tree before allowing retry.
        if (process.platform === "win32") execFile("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"],
          { windowsHide: true, timeout: 10_000 }, () => child.kill());
        else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
      }, 180_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => {
        clearTimeout(timer);
        if (code === 0 && !timedOut) resolve(); else reject(new Error("Installer failed"));
      });
    });
    return { ok: true, message: "Installed. Complete the runtime’s sign-in, then register this environment." };
  } catch {
    return { ok: false, message: "Installation failed or timed out. Check that Node.js/npm is installed and your user can install global packages." };
  } finally { installing = false; }
}
