import { createGateway } from "@ai-sdk/gateway";
import { experimental_evaluate as evaluate, InvalidArgumentError } from "ai";

export const JEV_MODEL = "typesafe-ai/jev";
export const MAX_INPUT_BYTES = 65_536;

/**
 * A server/local-only Jev entry point. Input is { state, questions }, using
 * AI SDK evaluation question types. This client has no dispatch authority.
 */
export function createJevClient({ apiKey, timeoutMs = 15_000, zeroDataRetention = false, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("Set AI_GATEWAY_API_KEY through your secret store or local environment.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("timeoutMs must be between 1 and 60000.");
  }
  if (typeof zeroDataRetention !== "boolean") throw new Error("zeroDataRetention must be a boolean.");
  const gateway = createGateway({
    apiKey: apiKey.trim(),
    // Never forward the credential through a redirect.
    fetch: async (url, init) => {
      const response = await fetchImpl(url, { ...init, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error("Unexpected gateway redirect");
      }
      return response;
    },
  });

  return {
    async evaluate(input, { signal } = {}) {
      if (!input || typeof input !== "object" || Array.isArray(input)
        || Object.keys(input).some((key) => !["state", "questions"].includes(key))) {
        throw new Error("Expected an object with state and questions only.");
      }
      const serialized = JSON.stringify(input);
      if (new TextEncoder().encode(serialized).byteLength > MAX_INPUT_BYTES) {
        throw new Error("Evaluation input exceeds 65536 bytes.");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abortSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try {
        const result = await evaluate({
          model: gateway.evaluationModel(JEV_MODEL),
          state: input.state,
          questions: input.questions,
          maxRetries: 0,
          abortSignal,
          ...(zeroDataRetention ? { providerOptions: { gateway: { zeroDataRetention: true } } } : {}),
        });
        // Omit raw response bodies, headers and provider diagnostics.
        // `rounding` is the precision the answers were validated at; a caller
        // that checks them again must allow the same.
        return { model: JEV_MODEL, answers: result.answers, usage: result.usage,
          ...(result.rounding ? { rounding: result.rounding } : {}) };
      } catch (error) {
        let verificationRequired = false;
        if (error?.statusCode === 403) {
          try {
            const body = JSON.parse(error.cause?.responseBody ?? "null");
            verificationRequired = body?.error?.type === "customer_verification_required";
          } catch { /* Only use the provider's exact typed code. */ }
        }
        const code = abortSignal.aborted ? "jev_aborted"
          : InvalidArgumentError.isInstance(error) ? "jev_invalid_input"
          : verificationRequired ? "jev_customer_verification_required"
          : error?.statusCode === 401 ? "jev_auth_failed"
          : error?.statusCode === 403 ? "jev_permission_denied"
          : error?.statusCode === 429 ? "jev_rate_limited" : "jev_evaluation_failed";
        const safeError = new Error(code);
        safeError.code = code;
        throw safeError;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
