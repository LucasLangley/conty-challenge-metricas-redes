import type { MetricValues } from "./metrics.ts";

export type ProviderPost = MetricValues & { postId: string; publishedAt: string };

export type ListPostsRequest = {
  accountId: string;
  accessToken: string;
  since: Date;
  until: Date;
  cursor: string | null;
};

export type PostPage = { posts: ProviderPost[]; nextCursor: string | null };

// Fronteira com o provedor. Quem implementa traduz o protocolo (status, headers,
// formato do corpo) para estes tipos; a regra de sync não vê HTTP.
// `signal` aborta quando o prazo da chamada estoura (ou quando ela já não
// interessa); um adaptador real o repassa ao `fetch` para largar a conexão.
export interface MetricsProvider {
  listPosts(request: ListPostsRequest, signal: AbortSignal): Promise<PostPage>;
}

export type ProviderErrorKind = "transient" | "rate_limited" | "fatal";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
