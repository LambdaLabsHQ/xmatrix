import { sha256Hex } from "@xmatrix/protocol";

type AuthMetricInput = {
  routeGroup: string;
  status: number;
  outcome?: string;
  authProvider?: string;
  userId?: string;
};

export async function logAuthMetric(input: AuthMetricInput): Promise<void> {
  const userIdHash = input.userId ? await hashForLog(input.userId) : undefined;
  console.log(
    JSON.stringify({
      event: "xmatrix_auth_metric",
      minute: minuteBucket(),
      routeGroup: input.routeGroup,
      status: input.status,
      outcome: input.outcome,
      authProvider: input.authProvider,
      userIdHash,
    })
  );
}

function minuteBucket(): string {
  return new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
}

async function hashForLog(value: string): Promise<string> {
  return (await sha256Hex(value)).slice(0, 24);
}
