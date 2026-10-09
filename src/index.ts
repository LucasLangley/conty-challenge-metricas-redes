import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { defaultRetryPolicy } from "./domain/retry.ts";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./domain/sync.ts";
import { FakeProvider } from "./providers/fake.ts";
import type { RawPost } from "./providers/http-response.ts";
import { MemoryStore } from "./store.ts";

const HOUR_MS = 60 * 60 * 1000;
const now = systemClock.now().getTime();

function demoPosts(prefix: string, count: number): RawPost[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}_${i + 1}`,
    published_at: new Date(now - (i + 1) * 12 * HOUR_MS).toISOString(),
    view_count: 1000 * (count - i),
    like_count: 80 * (count - i),
    comment_count: 7 * (count - i),
  }));
}

// Provedores simulados para rodar localmente. Os roteiros iniciais mostram cada
// caminho de erro na primeira sync: TikTok responde 429 com Retry-After curto,
// YouTube responde 429 com Retry-After acima do teto, X responde 503 uma vez.
const catalog = (account: string, prefix: string) => ({
  postsByAccount: { [account]: demoPosts(prefix, 5) },
  pageSize: 2,
});
const providers = {
  instagram: new FakeProvider(systemClock, [], catalog("ig_ana", "ig")),
  tiktok: new FakeProvider(systemClock, [{ status: 429, headers: { "Retry-After": "2" } }], catalog("tt_ana", "tt")),
  youtube: new FakeProvider(systemClock, [{ status: 429, headers: { "Retry-After": "3600" } }], catalog("yt_ana", "yt")),
  x: new FakeProvider(systemClock, [{ status: 503 }], catalog("x_ana", "x")),
};

const app = createApp({
  store: new MemoryStore(),
  providers,
  clock: systemClock,
  retry: defaultRetryPolicy,
  maxPages: 100,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  defaultWindowDays: 7,
});
const port = Number(process.env.PORT ?? 3004);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`métricas das redes em http://127.0.0.1:${info.port}`);
});
