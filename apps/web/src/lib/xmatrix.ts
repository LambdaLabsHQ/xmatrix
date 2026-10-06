import { DEFAULT_HUB_URL, normalizeHubUrl } from "@xmatrix/protocol";

/**
 * The Web worker must use the same Hub origin that its browser client uses.
 *
 * `XMATRIX_HUB_URL` is an agent/CLI override and can persist as an unrelated
 * Worker secret between deployments. Letting it override this proxy created a
 * split deployment: the current browser could send Focus refreshes through an
 * older Hub and receive its obsolete untracked `{ accepted: true }` response.
 * A Web Hub override therefore has to be public/build-consistent.
 */
export function getXMatrixHubUrl(
  environment?: { NEXT_PUBLIC_XMATRIX_HUB_URL?: string },
): string {
  return normalizeHubUrl(
    environment?.NEXT_PUBLIC_XMATRIX_HUB_URL || process.env.NEXT_PUBLIC_XMATRIX_HUB_URL || DEFAULT_HUB_URL
  );
}
