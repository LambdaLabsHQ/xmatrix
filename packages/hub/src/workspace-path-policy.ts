/**
 * Directories xMatrix itself owns on a Machine, recognized by their layout:
 * `~/.xmatrix` (each Run's execution worktree and the managed repository
 * mirrors) and `~/.config/xmatrix` (configuration and repo pools). A Workspace
 * is a directory its owner works in, so none of these can be one. The CLI
 * refuses them with the Machine's real roots; this is the Hub's own check of
 * the same boundary, and it hides records older clients registered there.
 */
export function isXmatrixOwnedDirectory(canonicalCwd: string): boolean {
  const segments = canonicalCwd.split(/[\\/]+/u).map(segment => segment.toLowerCase());
  return segments.some((segment, index) =>
    segment === ".xmatrix" || (segment === ".config" && segments[index + 1] === "xmatrix"));
}
