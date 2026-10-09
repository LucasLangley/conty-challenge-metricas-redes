import type { ProviderError } from "./provider.ts";

export type RetryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxBackoffMs: number;
  maxRetryAfterMs: number;
};

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxBackoffMs: 30_000,
  maxRetryAfterMs: 60_000,
};

export type RetryDecision = { retry: true; waitMs: number } | { retry: false };

export function backoffMs(attempt: number, policy: RetryPolicy): number {
  return Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxBackoffMs);
}

// `attempt` é quantas chamadas já foram feitas para esta página (começa em 1).
// - erro definitivo (token inválido, resposta ilegível): não tenta de novo;
// - teto de tentativas atingido: para, seja qual for o erro;
// - 429 com Retry-After: espera exatamente o prazo do provedor; se o prazo passa
//   do teto, não espera nem insiste antes da hora, e a sync termina como
//   rate_limited guardando quando o provedor aceita de novo;
// - timeout, 5xx e 429 sem Retry-After: backoff exponencial com teto.
export function decideRetry(error: ProviderError, attempt: number, policy: RetryPolicy): RetryDecision {
  if (error.kind === "fatal") return { retry: false };
  if (attempt >= policy.maxAttempts) return { retry: false };
  if (error.kind === "rate_limited" && error.retryAfterMs !== null) {
    if (error.retryAfterMs > policy.maxRetryAfterMs) return { retry: false };
    return { retry: true, waitMs: error.retryAfterMs };
  }
  return { retry: true, waitMs: backoffMs(attempt, policy) };
}
