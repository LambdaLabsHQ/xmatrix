import { record } from "./event-format";

// Return typed Google failure context, never the raw error body or credentials.
export function describeGoogleError(payload: Record<string, unknown>): string {
  const error = record(payload.error);
  const details = Array.isArray(error.details) ? error.details : [];
  const info = details.map(record).find(detail => detail["@type"] === "type.googleapis.com/google.rpc.ErrorInfo");
  const metadata = record(info?.metadata);
  const parts: string[] = [];
  const legacyReasons = new Set(["accessNotConfigured", "insufficientPermissions", "forbidden", "authError",
    "rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "quotaExceeded"]);
  const legacy = (Array.isArray(error.errors) ? error.errors : []).map(record)
    .find(item => typeof item.reason === "string" && legacyReasons.has(item.reason));
  if (typeof info?.reason === "string" && /^[A-Z_]{1,80}$/u.test(info.reason)) parts.push(info.reason);
  else if (legacy) parts.push(String(legacy.reason));
  if (typeof metadata.service === "string" && /^[a-z0-9.-]+\.googleapis\.com$/u.test(metadata.service)) parts.push(`API=${metadata.service}`);
  if (typeof metadata.consumer === "string" && /^projects\/[0-9]{1,20}$/u.test(metadata.consumer)) parts.push(`consumer=${metadata.consumer}`);
  const permission = typeof error.message === "string" ? error.message.match(/(?:[a-z][a-zA-Z]+\.){2,4}[a-z][a-zA-Z]+/u)?.[0] : undefined;
  if (permission && /^(appoptimize|cloudasset|bigquery|billing|serviceusage|resourcemanager|run|logging|monitoring|apikeys)\./u.test(permission)) parts.push(`permission=${permission}`);
  if (!parts.length && typeof error.status === "string" && /^[A-Z_]{1,80}$/u.test(error.status)) parts.push(error.status);
  return parts.length ? parts.join("; ") : "Google API request failed without typed error details";
}
