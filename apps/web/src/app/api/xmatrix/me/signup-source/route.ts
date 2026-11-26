import { HUB_ROUTES } from "@xmatrix/protocol";
import { hubRouteHandler } from "@/lib/xmatrix-proxy";

/** Where a new account came from, sent once by its first page (lib/signup-source.ts). */
export const POST = hubRouteHandler("POST", HUB_ROUTES.me_signup_source);
