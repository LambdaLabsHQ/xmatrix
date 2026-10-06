/**
 * Roles that read a Space but do not act in it: a viewer, and a participant of
 * an open project outside their own intake conversations
 * (docs/design/open-project-governance.md §2). Neither is billed.
 */
export function readsOnly(role: string | null | undefined): boolean {
  return role === "viewer" || role === "participant";
}
