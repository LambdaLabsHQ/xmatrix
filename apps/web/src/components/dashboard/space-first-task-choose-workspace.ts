import type { DesktopWorkspaceCandidate } from "@/lib/desktop/bridge";
import { isXmatrixManagedWorkspacePath } from "./space-first-task";

/* Giving a Space somewhere to work is one explicit act: the human opens the
   system folder picker — which can create a folder — and what they point at is
   what gets registered. Nothing is offered from what the machine happens to
   have registered already, because that list spans every organisation this
   person works for. */

/* Registration needs the machine identity the picker reported, so the chosen
   folder keeps the candidate's shape rather than a reduced copy of it. */
export type ChosenWorkspace = DesktopWorkspaceCandidate;

export type ChooseWorkspaceOutcome =
  | { kind: "chosen"; workspace: ChosenWorkspace }
  /* The human closed the picker; not an error, and nothing should be said. */
  | { kind: "cancelled" }
  | { kind: "rejected"; reason: string };

/** Validates a picked folder before anything is registered against it. */
export function reviewChosenWorkspace(
  candidate: DesktopWorkspaceCandidate | null | undefined
): ChooseWorkspaceOutcome {
  if (!candidate) return { kind: "cancelled" };
  const canonicalCwd = candidate.canonicalCwd?.trim() || "";
  if (!canonicalCwd) return { kind: "cancelled" };

  if (isXmatrixManagedWorkspacePath(canonicalCwd)) {
    return {
      kind: "rejected",
      reason: "That folder belongs to xMatrix itself. Choose or create a folder of your own.",
    };
  }
  /* A home directory or the filesystem root as a working directory hands the
     agent everything the human owns, which is never what they meant to grant. */
  if (isRootOrHomeDirectory(canonicalCwd)) {
    return {
      kind: "rejected",
      reason: "Choose a project folder rather than your home folder or the disk root.",
    };
  }

  return {
    kind: "chosen",
    workspace: {
      ...candidate,
      canonicalCwd,
      displayName: candidate.displayName?.trim() || folderNameOf(canonicalCwd) || canonicalCwd,
    },
  };
}

export function isRootOrHomeDirectory(path: string): boolean {
  const normalized = path.replace(/[\\/]+$/u, "");
  if (!normalized) return true;
  /* Windows drive root, e.g. `C:`. */
  if (/^[A-Za-z]:$/u.test(normalized)) return true;

  const segments = normalized.split(/[\\/]/u).filter(Boolean);
  if (segments.length === 0) return true;
  /* `/Users/<name>`, `/home/<name>`, `C:\Users\<name>` — the user's home. */
  if (segments.length === 2 && /^(users|home)$/iu.test(segments[0]!)) return true;
  if (segments.length === 3 && /^[A-Za-z]:$/u.test(segments[0]!) && /^users$/iu.test(segments[1]!)) {
    return true;
  }
  return false;
}

function folderNameOf(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) || "";
}
