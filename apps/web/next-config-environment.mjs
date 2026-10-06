const DEFAULT_HUB_ORIGIN = "https://xmatrix-hub.xmatrix.sh";

export function configuredHubOrigin(environment = process.env) {
  const rawHubUrl =
    environment.NEXT_PUBLIC_AUTH_BASE_URL ||
    environment.NEXT_PUBLIC_XMATRIX_HUB_URL ||
    DEFAULT_HUB_ORIGIN;

  let hubUrl;
  try {
    hubUrl = new URL(rawHubUrl);
  } catch {
    throw new Error("The configured Hub URL must be an absolute HTTP(S) origin");
  }
  if (
    (hubUrl.protocol !== "http:" && hubUrl.protocol !== "https:") ||
    hubUrl.username || hubUrl.password || hubUrl.pathname !== "/" ||
    hubUrl.search || hubUrl.hash
  ) {
    throw new Error("The configured Hub URL must be an absolute HTTP(S) origin");
  }
  return hubUrl.origin;
}

export function configuredHubConnectSources(hubOrigin) {
  const hubUrl = new URL(hubOrigin);
  return [
    hubUrl.origin,
    `${hubUrl.protocol === "http:" ? "ws" : "wss"}://${hubUrl.host}`,
  ];
}
