import { type PostPage, type ProviderPost, ProviderError } from "../domain/provider.ts";

// O que um adaptador HTTP de verdade recebe do provedor. O provedor falso
// devolve isto, e a tradução para o domínio é a mesma que um adaptador real usaria.
export type HttpLikeResponse = {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
};

export type RawPost = {
  id: string;
  published_at: string;
  view_count: number;
  like_count: number;
  comment_count: number;
};

// Retry-After vem em segundos ("120") ou como HTTP-date ("Fri, 09 Oct 2026 12:00:05 GMT").
// Data no passado vira espera zero; valor ilegível é tratado como ausente.
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export function parseRetryAfter(value: string | undefined, now: Date): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = HTTP_DATE.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now.getTime());
}

function header(response: HttpLikeResponse, name: string): string | undefined {
  const entry = Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

export function toPostPage(response: HttpLikeResponse, now: Date): PostPage {
  const { status } = response;
  if (status === 429) {
    throw new ProviderError("rate_limited", "provedor respondeu 429", parseRetryAfter(header(response, "retry-after"), now));
  }
  if (status === 408 || status >= 500) throw new ProviderError("transient", `provedor respondeu ${status}`);
  if (status !== 200) throw new ProviderError("fatal", `provedor respondeu ${status}`);
  return parseBody(response.body);
}

function parseBody(body: unknown): PostPage {
  if (!body || typeof body !== "object") throw new ProviderError("fatal", "corpo da resposta inválido");
  const { data, next_cursor } = body as { data?: unknown; next_cursor?: unknown };
  if (!Array.isArray(data)) throw new ProviderError("fatal", "corpo da resposta sem lista de posts");
  if (next_cursor !== null && next_cursor !== undefined && typeof next_cursor !== "string") {
    throw new ProviderError("fatal", "cursor inválido");
  }
  return { posts: data.map(parsePost), nextCursor: next_cursor ?? null };
}

const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

function parsePost(raw: unknown): ProviderPost {
  const post = (raw ?? {}) as Partial<RawPost>;
  if (
    typeof post.id !== "string" ||
    !post.id ||
    typeof post.published_at !== "string" ||
    !isCount(post.view_count) ||
    !isCount(post.like_count) ||
    !isCount(post.comment_count)
  ) {
    throw new ProviderError("fatal", "post com formato inválido na resposta");
  }
  return {
    postId: post.id,
    publishedAt: post.published_at,
    views: post.view_count,
    likes: post.like_count,
    comments: post.comment_count,
  };
}
