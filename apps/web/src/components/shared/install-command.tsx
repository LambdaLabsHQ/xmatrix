"use client";

import { useEffect, useMemo, useState } from "react";
import { CopyableCodeBlock } from "@/components/shared/copyable-code-block";
import { LiquidGlassPill } from "@/components/ui/material-surfaces";
import { cn } from "@/lib/utils";

type InstallOs = "macos" | "linux" | "windows";

const OS_LABELS: Record<InstallOs, string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

const INSTALL_COMMANDS: Record<InstallOs, string> = {
  macos: "curl -fsSL https://xmatrix.sh/install.sh | bash",
  linux: "curl -fsSL https://xmatrix.sh/install.sh | bash",
  windows:
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://xmatrix.sh/install.ps1 | iex"',
};

function detectInstallOs(): InstallOs {
  if (typeof navigator === "undefined") {
    return "macos";
  }

  const uaDataPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData?.platform;
  const platform = `${uaDataPlatform || navigator.platform || ""} ${navigator.userAgent || ""}`
    .toLowerCase();

  if (platform.includes("win")) {
    return "windows";
  }
  if (platform.includes("linux") || platform.includes("x11")) {
    return "linux";
  }
  return "macos";
}

export function InstallCommand({
  className,
}: {
  className?: string;
}) {
  const [selectedOs, setSelectedOs] = useState<InstallOs>("macos");

  useEffect(() => {
    setSelectedOs(detectInstallOs());
  }, []);

  const command = useMemo(() => INSTALL_COMMANDS[selectedOs], [selectedOs]);

  return (
    <div className={cn("min-w-0 space-y-3", className)}>
      <div className="flex max-w-full flex-wrap gap-1">
        {(Object.keys(OS_LABELS) as InstallOs[]).map((os) => {
          const selected = selectedOs === os;
          return (
            <LiquidGlassPill
              key={os}
              as="button"
              type="button"
              enabled={selected}
              fill={selected}
              aria-pressed={selected}
              onClick={() => setSelectedOs(os)}
              className="relative h-8 px-4 text-xs font-semibold"
            >
              {OS_LABELS[os]}
            </LiquidGlassPill>
          );
        })}
      </div>
      <CopyableCodeBlock code={command} />
    </div>
  );
}
