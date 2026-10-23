import { HUB_ROUTES } from "@xmatrix/protocol";
import { spaceSubpathHandlers } from "@/lib/xmatrix-proxy";

/** Forwards a read of faces by id to the Hub, which answers a member of the Space (protocol faces.ts). */
export const { GET } = spaceSubpathHandlers(HUB_ROUTES.space_faces, { search: true });
