/** The Web's proxy routes this build bundles, listed by apps/chrome-extension/scripts/build-app.mjs. */
declare module "xmatrix-extension:api-routes" {
  export const API_ROUTES: readonly import("./local-api").ApiRoute[];
}
