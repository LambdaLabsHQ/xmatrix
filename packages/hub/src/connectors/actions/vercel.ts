import { providerJson } from "../http";
import { vercelApiUrl } from "../vercel-api";
import type { ConnectorAction } from "../provider";

const DEPLOYMENT = /^dpl_[A-Za-z0-9]{8,64}$/u;

function api(credentials: Readonly<Record<string, string>>, path: string): URL {
  return vercelApiUrl(credentials, path);
}

export const VERCEL_ACTIONS: Record<string, ConnectorAction> = {
  redeploy: {
    effect: "write",
    requires: ["accessToken|oauthToken"],
    parse: (statement) => DEPLOYMENT.test(statement.target) ? { deployment: statement.target }
      : "name a deployment id: @vercel:redeploy:dpl_…",
    async execute({ credentials }, input) {
      const headers = { authorization: `Bearer ${credentials.oauthToken || credentials.accessToken}` };
      const current = await providerJson(api(credentials, `v13/deployments/${encodeURIComponent(input.deployment!)}`), { headers });
      const created = await providerJson(api(credentials, "v13/deployments"), { method: "POST", headers,
        json: { name: current.name, deploymentId: input.deployment,
          ...(current.target === "production" ? { target: "production" } : {}) } });
      const url = typeof created.url === "string" ? `https://${created.url}` : undefined;
      return { summary: `Redeployed ${String(current.name ?? input.deployment)}`, ...(url ? { url } : {}) };
    },
  },
};
