import { describe, expect, it } from "vitest";
import { decideSnapshot } from "../src/domain/metrics.ts";
import { ProviderError } from "../src/domain/provider.ts";
import { type RetryPolicy, decideRetry } from "../src/domain/retry.ts";
import { parseRetryAfter, toPostPage } from "../src/providers/http-response.ts";

const NOW = new Date("2026-10-09T12:00:00.000Z");
const policy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxBackoffMs: 1_500, maxRetryAfterMs: 10_000 };

function caught(fn: () => unknown): ProviderError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ProviderError) return err;
    throw err;
  }
  throw new Error("esperava ProviderError");
}

describe("parseRetryAfter", () => {
  it("lê segundos", () => {
    expect(parseRetryAfter("120", NOW)).toBe(120_000);
    expect(parseRetryAfter(" 0 ", NOW)).toBe(0);
  });

  it("lê HTTP-date relativo ao relógio", () => {
    expect(parseRetryAfter("Fri, 09 Oct 2026 12:01:00 GMT", NOW)).toBe(60_000);
  });

  it("data no passado vira espera zero", () => {
    expect(parseRetryAfter("Fri, 09 Oct 2026 11:00:00 GMT", NOW)).toBe(0);
  });

  it("ausente ou ilegível vira null", () => {
    expect(parseRetryAfter(undefined, NOW)).toBeNull();
    expect(parseRetryAfter("logo", NOW)).toBeNull();
    expect(parseRetryAfter("-5", NOW)).toBeNull();
  });
});

describe("tradução da resposta do provedor", () => {
  it("200 vira página com métricas absolutas", () => {
    const page = toPostPage(
      {
        status: 200,
        body: {
          data: [{ id: "p1", published_at: "2026-10-01T00:00:00Z", view_count: 10, like_count: 2, comment_count: 1 }],
          next_cursor: "abc",
        },
      },
      NOW,
    );
    expect(page).toEqual({
      posts: [{ postId: "p1", publishedAt: "2026-10-01T00:00:00Z", views: 10, likes: 2, comments: 1 }],
      nextCursor: "abc",
    });
  });

  it("429 carrega o Retry-After, sem importar a caixa do header", () => {
    const err = caught(() => toPostPage({ status: 429, headers: { "RETRY-AFTER": "7" } }, NOW));
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(7_000);
  });

  it("408 e 5xx são transitórios; 401, 403 e 404 são definitivos", () => {
    for (const status of [408, 500, 502, 503, 504]) expect(caught(() => toPostPage({ status }, NOW)).kind).toBe("transient");
    for (const status of [400, 401, 403, 404]) expect(caught(() => toPostPage({ status }, NOW)).kind).toBe("fatal");
  });

  it("corpo malformado ou contagem negativa é erro definitivo", () => {
    expect(caught(() => toPostPage({ status: 200, body: { items: [] } }, NOW)).kind).toBe("fatal");
    const negative = { id: "p1", published_at: "x", view_count: -1, like_count: 0, comment_count: 0 };
    expect(caught(() => toPostPage({ status: 200, body: { data: [negative] } }, NOW)).kind).toBe("fatal");
  });
});

describe("decideRetry", () => {
  const transient = new ProviderError("transient", "timeout");

  it("backoff exponencial com teto", () => {
    expect(decideRetry(transient, 1, { ...policy, maxAttempts: 9 })).toEqual({ retry: true, waitMs: 500 });
    expect(decideRetry(transient, 2, { ...policy, maxAttempts: 9 })).toEqual({ retry: true, waitMs: 1_000 });
    expect(decideRetry(transient, 3, { ...policy, maxAttempts: 9 })).toEqual({ retry: true, waitMs: 1_500 });
  });

  it("não passa do número máximo de tentativas", () => {
    expect(decideRetry(transient, 3, policy)).toEqual({ retry: false });
  });

  it("429 usa o Retry-After até o teto e desiste acima dele", () => {
    expect(decideRetry(new ProviderError("rate_limited", "429", 10_000), 1, policy)).toEqual({
      retry: true,
      waitMs: 10_000,
    });
    expect(decideRetry(new ProviderError("rate_limited", "429", 10_001), 1, policy)).toEqual({ retry: false });
  });

  it("erro definitivo nunca tem retry", () => {
    expect(decideRetry(new ProviderError("fatal", "401"), 1, policy)).toEqual({ retry: false });
  });
});

describe("decideSnapshot", () => {
  it("novo, igual ou atualizado", () => {
    const v = { views: 10, likes: 1, comments: 0 };
    expect(decideSnapshot(undefined, v)).toBe("created");
    expect(decideSnapshot(v, { ...v })).toBe("unchanged");
    expect(decideSnapshot(v, { ...v, comments: 1 })).toBe("updated");
  });
});
