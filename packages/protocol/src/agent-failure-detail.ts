import { sanitizeMachineFailureDetail } from "./machine-failure-detail.js";

/** Observations only: these fields never authorise retries, sign-out or handoff. */
export interface AgentFailureEvidence {
  category: "http" | "timeout" | "dns" | "tls" | "connection" | "process" | "rpc" | "provider";
  httpStatuses: number[];
  codes: string[];
  requestIds: string[];
  websocketCloseCodes: number[];
  exitCodes: number[];
}

export function safeAgentFailureDetail(detail: string | undefined | null): string {
  return sanitizeMachineFailureDetail(detail ?? "", 4_000).replace(/[@＠]/gu, "﹫");
}

/** Read labelled evidence, never an arbitrary three-digit number in prose. */
export function agentFailureEvidence(detail: string | undefined | null): AgentFailureEvidence {
  const text = safeAgentFailureDetail(detail);
  const numbers = (pattern: RegExp) => [...new Set(Array.from(text.matchAll(pattern), (match) => Number(match[1])))].slice(0, 8);
  const values = (pattern: RegExp) => [...new Set(Array.from(text.matchAll(pattern), (match) => match[1]!))].slice(0, 8);
  const httpStatuses = numbers(/\b(?:http(?:\/[\d.]+)?(?:[_ -]?status(?:[_ -]?code)?)?|status(?:[_ -]?code)?|api error|unexpected status)["']?\s*[:=]?\s*["']?([1-5]\d{2})\b/giu);
  const codes = values(/\b(?:code|error[_ -]?code|codexErrorInfo)["']?\s*[:=]\s*["']?(-?[a-z0-9_./-]{1,80})/giu);
  const requestIds = values(/\b(?:request[_ -]?id|x-request-id|cf-ray)["']?\s*[:=]\s*["']?([a-z0-9_-]{1,128})/giu);
  const websocketCloseCodes = numbers(/\bwebsocket close code\s*[:=]\s*(?:Some\()?(\d{4})\b/giu);
  const exitCodes = numbers(/\b(?:exit(?:ed with)? (?:status|code)|exitCode)\s*[:=]?\s*(-?\d{1,10})\b/giu);
  const category = httpStatuses.length ? "http"
    : /\b(?:timed out|timeout|ETIMEDOUT)\b/iu.test(text) ? "timeout"
    : /\b(?:DNS|ENOTFOUND|EAI_AGAIN|name resolution)\b/iu.test(text) ? "dns"
    : /\b(?:TLS|SSL|certificate)\b/iu.test(text) ? "tls"
    : /\b(?:ECONNREFUSED|ECONNRESET|connection (?:lost|closed|reset|refused)|broken pipe)\b/iu.test(text) ? "connection"
    : exitCodes.length || /\b(?:process exited|signal=|SIGTERM|SIGKILL)\b/iu.test(text) ? "process"
    : codes.some((code) => /^-\d+$/u.test(code)) ? "rpc" : "provider";
  return { category, httpStatuses, codes, requestIds, websocketCloseCodes, exitCodes };
}

export function agentFailureStatusLines(evidence: AgentFailureEvidence): string[] {
  return [
    "Failure category: " + evidence.category + ". HTTP status: " + (evidence.httpStatuses.length ? evidence.httpStatuses.join(", ") : "not reported by the harness") + ".",
    ...(evidence.codes.length ? ["Upstream code: " + evidence.codes.join(", ") + "."] : []),
    ...(evidence.requestIds.length ? ["Upstream request: " + evidence.requestIds.join(", ") + "."] : []),
    ...(evidence.websocketCloseCodes.length ? ["WebSocket close code: " + evidence.websocketCloseCodes.join(", ") + "."] : []),
    ...(evidence.exitCodes.length ? ["Process exit code: " + evidence.exitCodes.join(", ") + "."] : []),
  ];
}
