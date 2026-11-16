/** Personal device state requires both its reader and its Space. An old
 * Space-only key has no provable owner and is deliberately never adopted. */
export type UserSpaceLocalScope = { userId: string | null | undefined; spaceId: string | null | undefined };

export function userSpaceLocalState<T>(name: string, decode: (value: unknown) => T | undefined) {
  const key = ({ userId, spaceId }: UserSpaceLocalScope) => userId && spaceId
    ? `xmatrix:user-space:${JSON.stringify([name, userId, spaceId])}` : null;
  return {
    read(scope: UserSpaceLocalScope): T | undefined {
      const address = key(scope);
      if (!address) return undefined;
      try {
        const text = typeof window === "undefined" ? null : window.localStorage.getItem(address);
        return text ? decode(JSON.parse(text)) : undefined;
      } catch {
        return undefined;
      }
    },
    write(scope: UserSpaceLocalScope, value: T): void {
      const address = key(scope);
      if (!address) return;
      try {
        if (typeof window !== "undefined") window.localStorage.setItem(address, JSON.stringify(value));
      } catch {
        // A full or blocked store must not interrupt sending, searching or calling an Agent.
      }
    },
  };
}
