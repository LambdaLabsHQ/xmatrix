"use client";

import { useEffect, useState } from "react";

/** Let the foreground Channel or first catalog page finish first; a failed read cannot starve other UI. */
export function useStartupBackgroundReady(key: string | null, settled: boolean): boolean {
  const [releasedKey, setReleasedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!key || settled) return;
    const timer = window.setTimeout(() => setReleasedKey(key), 8_000);
    return () => window.clearTimeout(timer);
  }, [key, settled]);
  return !key || settled || releasedKey === key;
}
