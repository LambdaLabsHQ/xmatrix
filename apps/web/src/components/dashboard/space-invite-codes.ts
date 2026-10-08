/**
 * Minting shareable Space invite links.
 *
 * Lives apart from the workspace action hook because that file sits at the
 * repository's 5000-line ceiling, and because this is self-contained: it needs
 * a caller, a Space, and the wire call, nothing from the hook's state.
 */
import { WEB_PROXY_ROUTES, type SerializedSpace } from "@xmatrix/protocol";
import { canInviteToSpace } from "@/components/dashboard/workspace-shell-recovered";
import { xmatrixRawResponse } from "@/lib/query/api-client";

export type SpaceInviteCodeOptions = {
  /** `"unlimited"` is a standing secret; callers must choose it deliberately. */
  maxUses: number | "unlimited";
  expiresInHours?: number;
  requiresApproval: boolean;
};

/**
 * The plaintext token comes back exactly once — the Hub keeps only its hash —
 * so whatever calls this has to surface the link immediately or lose it.
 */
export async function createSpaceInviteCodeRequest(input: {
  token: string | null | undefined;
  userId: string | undefined;
  spaces: SerializedSpace[];
  spaceId: string;
  options: SpaceInviteCodeOptions;
}): Promise<{ token: string }> {
  const { token, userId, spaces, spaceId, options } = input;
  if (!token || !userId) throw new Error("Sign in before creating an invite code");
  const space = spaces.find((item) => item.id === spaceId);
  if (!space || !canInviteToSpace(space, userId)) {
    throw new Error("Only workspace owners and admins can create invite codes");
  }
  const response = await xmatrixRawResponse(WEB_PROXY_ROUTES.space_invites(spaceId), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      role: "member",
      maxUses: options.maxUses,
      requiresApproval: options.requiresApproval,
      ...(options.expiresInHours ? { expiresInHours: options.expiresInHours } : {}),
    }),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as {
    invite?: { token?: string };
    error?: string;
  };
  if (!response.ok || !payload.invite?.token) {
    throw new Error(payload.error || "Failed to create invite code");
  }
  return { token: payload.invite.token };
}
