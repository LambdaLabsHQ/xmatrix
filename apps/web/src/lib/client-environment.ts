export type XMatrixClientEnvironment = "production" | "test";

export const XMATRIX_CLIENT_ENVIRONMENTS = {
  production: {
    label: "Production",
    appOrigin: "https://xmatrix.sh",
    hubOrigin: "https://xmatrix-hub.xmatrix.sh",
  },
  test: {
    label: "Test",
    appOrigin: "https://test.xmatrix.sh",
    hubOrigin: "https://xmatrix-hub.test.xmatrix.sh",
  },
} as const;

export function clientEnvironmentForHostname(hostname: string): XMatrixClientEnvironment {
  return hostname.toLowerCase() === "test.xmatrix.sh" ? "test" : "production";
}

export function clientAppUrl(environment: XMatrixClientEnvironment): string {
  return `${XMATRIX_CLIENT_ENVIRONMENTS[environment].appOrigin}/app`;
}
