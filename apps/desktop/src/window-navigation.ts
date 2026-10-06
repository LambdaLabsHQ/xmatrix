const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export type WindowOpenPlan =
  | { kind: "external"; url: string }
  | { kind: "deny" };

export function planWindowOpen(value: string): WindowOpenPlan {
  try {
    const url = new URL(value);
    if (!SAFE_EXTERNAL_PROTOCOLS.has(url.protocol)) {
      return { kind: "deny" };
    }

    return { kind: "external", url: url.toString() };
  } catch {
    return { kind: "deny" };
  }
}
