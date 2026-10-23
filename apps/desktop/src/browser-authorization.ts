import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/*
 * Signing the app in at Google or GitHub through the person's own browser
 * (RFC 8252 §7.3): the Hub's sign-in page is opened there with a loopback
 * address of this app as its return, and the page the browser finally lands
 * on is the answer. A loopback port needs no registered URL scheme, so no
 * browser setting or other app can keep the answer from coming back.
 */

/** How long the browser may take before the app stops listening. */
export const AUTHORIZATION_TIMEOUT_MS = 10 * 60_000;

export interface BrowserAuthorizationRequest {
  url: string;
  redirectParam: string;
}

/** The one Hub that the beta and stable Webs both sign in through. */
const HUB_ORIGIN = "https://xmatrix-hub.xmatrix.sh";

/** A Hub sign-in start page: on exactly the Hub's origin, or any local host in a development build. */
export function hubSignInStartUrl(value: unknown, options: { allowLocal: boolean }): URL | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const allowed = url.origin === HUB_ORIGIN
    || (options.allowLocal && localHost && ["http:", "https:"].includes(url.protocol));
  return allowed && !url.username && !url.password && url.pathname === "/api/auth/app/start" ? url : null;
}

export function isRedirectParam(value: unknown): value is string {
  return typeof value === "string" && /^[a-z_]{1,32}$/u.test(value);
}

let current: { server: Server; abort: (error: Error) => void } | null = null;

/**
 * Opens the sign-in page in the browser and answers the loopback URL it
 * returns to. A newer sign-in replaces one still waiting, which is then
 * reported as cancelled.
 */
export function authorizeInBrowser(
  start: URL,
  redirectParam: string,
  open: (url: string) => Promise<void>,
  onAnswered: () => void,
): Promise<string> {
  current?.abort(abortError("A newer sign-in replaced this one"));
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const answer = new URL(request.url ?? "/", `http://127.0.0.1:${port()}`);
      if (request.method !== "GET" || answer.pathname !== "/callback" || settled) {
        response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      const signedIn = answer.searchParams.has("code");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        .end(answeredPage(signedIn));
      finish(() => resolve(answer.toString()));
      onAnswered();
    });
    const port = () => {
      const address = server.address();
      return typeof address === "object" && address ? address.port : 0;
    };
    const timeout = setTimeout(() => finish(() => reject(abortError("Sign-in timed out"))), AUTHORIZATION_TIMEOUT_MS);
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (current?.server === server) current = null;
      server.close();
      settle();
    };
    current = { server, abort: (error) => finish(() => reject(error)) };
    server.once("error", (error) => finish(() => reject(error)));
    server.listen(0, "127.0.0.1", () => {
      const page = new URL(start);
      page.searchParams.set(redirectParam, `http://127.0.0.1:${port()}/callback`);
      open(page.toString()).catch((error: unknown) =>
        finish(() => reject(error instanceof Error ? error : new Error("Couldn't open the browser"))));
    });
  });
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function answeredPage(signedIn: boolean): string {
  const text = signedIn
    ? "You're signed in. Go back to the xMatrix app; you can close this tab."
    : "Sign-in didn't finish. Go back to the xMatrix app to try again; you can close this tab.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>xMatrix</title></head>
<body style="font-family:system-ui,sans-serif;background:#f5efe5;color:#2a1c10;padding:40px 24px;max-width:28rem;margin:auto">
<p>${text}</p></body></html>`;
}
