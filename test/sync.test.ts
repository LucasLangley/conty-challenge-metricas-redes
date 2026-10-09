import { describe, expect, it } from "vitest";
import type { Connection } from "../src/domain/metrics.ts";
import { type MetricsProvider, ProviderError } from "../src/domain/provider.ts";
import type { RetryPolicy } from "../src/domain/retry.ts";
import { type SyncDeps, SyncInProgressError, syncConnection } from "../src/domain/sync.ts";
import { type FakeCatalog, FakeProvider, type ScriptStep } from "../src/providers/fake.ts";
import type { HttpLikeResponse, RawPost } from "../src/providers/http-response.ts";
import { MemoryStore } from "../src/store.ts";
import { ManualClock } from "./support/manual-clock.ts";

const START = "2026-10-09T12:00:00.000Z";
const T0 = new Date("2026-10-01T00:00:00.000Z");
const T1 = new Date("2026-10-03T00:00:00.000Z");
const T2 = new Date("2026-10-05T00:00:00.000Z");
const T3 = new Date("2026-10-07T00:00:00.000Z");
const WINDOW = { since: T0, until: T3 };

const policy: RetryPolicy = { maxAttempts: 4, baseDelayMs: 1_000, maxBackoffMs: 30_000, maxRetryAfterMs: 60_000 };

function raw(id: string, views: number, publishedAt = "2026-10-02T10:00:00.000Z"): RawPost {
  return { id, published_at: publishedAt, view_count: views, like_count: Math.floor(views / 10), comment_count: 1 };
}

function page(posts: RawPost[], nextCursor: string | null = null): HttpLikeResponse {
  return { status: 200, body: { data: posts, next_cursor: nextCursor } };
}

function setup(script: ScriptStep[] = [], options: { catalog?: FakeCatalog; retry?: RetryPolicy } = {}) {
  const clock = new ManualClock(START);
  const provider = new FakeProvider(clock, script, options.catalog);
  const store = new MemoryStore();
  const connection: Connection = {
    id: "conn_1",
    creatorId: "cr_ana",
    provider: "instagram",
    externalAccountId: "ig_ana",
    accessToken: "tok_fake",
    createdAt: clock.now(),
    lastSyncedAt: null,
  };
  store.insertConnection(connection);
  const deps: SyncDeps = {
    store,
    providers: { instagram: provider },
    clock,
    retry: options.retry ?? policy,
    maxPages: 20,
  };
  const sync = (window = WINDOW) => syncConnection(deps, store.getConnection("conn_1")!, window);
  return { clock, provider, store, deps, sync };
}

const totalViews = (store: MemoryStore) => store.listPostsByCreator("cr_ana").reduce((sum, p) => sum + p.views, 0);

describe("idempotência: o mesmo post não conta duas vezes", () => {
  it("post repetido na mesma página entra uma vez", async () => {
    const { store, sync } = setup([page([raw("p1", 100), raw("p1", 100), raw("p2", 50)])]);
    const run = await sync();

    expect(run.status).toBe("succeeded");
    expect(store.listPostsByCreator("cr_ana")).toHaveLength(2);
    expect(totalViews(store)).toBe(150);
    expect(store.listSnapshots("instagram", "p1")).toHaveLength(1);
    expect(run).toMatchObject({ postsReceived: 3, postsCreated: 2, postsUpdated: 0, postsUnchanged: 1 });
  });

  it("post repetido em outra página entra uma vez e segue o cursor", async () => {
    const { store, provider, sync } = setup([
      page([raw("p1", 100), raw("p2", 50)], "c1"),
      page([raw("p2", 50), raw("p3", 10)]),
    ]);
    const run = await sync();

    expect(provider.calls.map((c) => c.cursor)).toEqual([null, "c1"]);
    expect(run.pages).toBe(2);
    expect(store.listPostsByCreator("cr_ana")).toHaveLength(3);
    expect(totalViews(store)).toBe(160);
    expect(store.listSnapshots("instagram", "p2")).toHaveLength(1);
  });

  it("janelas sobrepostas [t0,t2] e [t1,t3] não duplicam os posts do trecho comum", async () => {
    const catalog: FakeCatalog = {
      pageSize: 2,
      postsByAccount: {
        ig_ana: [
          raw("a", 100, "2026-10-02T00:00:00.000Z"), // só na primeira janela
          raw("b", 200, "2026-10-03T12:00:00.000Z"), // nas duas
          raw("c", 300, "2026-10-04T12:00:00.000Z"), // nas duas
          raw("d", 400, "2026-10-06T00:00:00.000Z"), // só na segunda
        ],
      },
    };
    const { store, clock, sync } = setup([], { catalog });

    const first = await sync({ since: T0, until: T2 });
    expect(first).toMatchObject({ status: "succeeded", postsCreated: 3, pages: 2 });
    const firstFetch = clock.now().toISOString();

    clock.advance(60 * 60 * 1000);
    const second = await sync({ since: T1, until: T3 });
    expect(second).toMatchObject({ status: "succeeded", postsReceived: 3, postsCreated: 1, postsUnchanged: 2 });

    const posts = store.listPostsByCreator("cr_ana");
    expect(posts.map((p) => p.postId).sort()).toEqual(["a", "b", "c", "d"]);
    expect(totalViews(store)).toBe(1000);
    for (const id of ["a", "b", "c", "d"]) expect(store.listSnapshots("instagram", id)).toHaveLength(1);
    expect(store.getPost("instagram", "b")!.fetchedAt.toISOString()).toBe(firstFetch);
  });

  it("no trecho comum, número novo substitui o anterior em vez de somar", async () => {
    const catalog: FakeCatalog = {
      pageSize: 10,
      postsByAccount: { ig_ana: [raw("b", 200, "2026-10-03T12:00:00.000Z")] },
    };
    const { store, clock, sync } = setup([], { catalog });
    await sync({ since: T0, until: T2 });

    catalog.postsByAccount.ig_ana![0] = raw("b", 260, "2026-10-03T12:00:00.000Z");
    clock.advance(60 * 60 * 1000);
    const second = await sync({ since: T1, until: T3 });

    expect(second.postsUpdated).toBe(1);
    const post = store.getPost("instagram", "b")!;
    expect(post.views).toBe(260);
    expect(post.fetchedAt.toISOString()).toBe("2026-10-09T13:00:00.000Z");
    expect(store.listSnapshots("instagram", "b").map((s) => s.views)).toEqual([200, 260]);
  });

  it("sync repetida com os mesmos números não grava nada", async () => {
    const { store, clock, sync } = setup([page([raw("p1", 100)]), page([raw("p1", 100)])]);
    await sync();
    clock.advance(5 * 60 * 1000);
    const again = await sync();

    expect(again).toMatchObject({ postsReceived: 1, postsCreated: 0, postsUpdated: 0, postsUnchanged: 1 });
    expect(store.listSnapshots("instagram", "p1")).toHaveLength(1);
    expect(store.getPost("instagram", "p1")!.fetchedAt.toISOString()).toBe(START);
  });
});

describe("falha transitória: retry com teto e backoff", () => {
  it("timeout e 5xx são tentados de novo com backoff exponencial", async () => {
    const { clock, sync, store } = setup([{ timeout: true }, { status: 503 }, page([raw("p1", 100)])]);
    const run = await sync();

    expect(run).toMatchObject({ status: "succeeded", requests: 3, waitedMs: 3_000 });
    expect(clock.sleeps).toEqual([1_000, 2_000]);
    expect(store.getPost("instagram", "p1")!.views).toBe(100);
  });

  it("para no teto de tentativas em vez de insistir para sempre", async () => {
    const script: ScriptStep[] = Array.from({ length: 10 }, () => ({ status: 500 }));
    const { clock, provider, sync, store } = setup(script);
    const run = await sync();

    expect(run.status).toBe("failed");
    expect(run.requests).toBe(4);
    expect(provider.pending).toBe(6);
    expect(clock.sleeps).toEqual([1_000, 2_000, 4_000]);
    expect(run.error).toContain("4 tentativa");
    expect(store.getConnection("conn_1")!.lastSyncedAt).toBeNull();
  });

  it("o backoff respeita o teto de espera", async () => {
    const script: ScriptStep[] = Array.from({ length: 5 }, () => ({ status: 502 }));
    const { clock, sync } = setup(script, { retry: { ...policy, maxAttempts: 5, maxBackoffMs: 3_000 } });
    await sync();
    expect(clock.sleeps).toEqual([1_000, 2_000, 3_000, 3_000]);
  });

  it("erro definitivo (401) não tem retry", async () => {
    const { clock, sync } = setup([{ status: 401 }, page([])]);
    const run = await sync();
    expect(run).toMatchObject({ status: "failed", requests: 1 });
    expect(clock.sleeps).toEqual([]);
  });

  it("falha na página 2 mantém a página 1, e repetir a sync não duplica", async () => {
    const failing: ScriptStep[] = Array.from({ length: 4 }, () => ({ timeout: true }) as const);
    const { store, sync, provider } = setup([page([raw("p1", 100)], "c1"), ...failing]);
    const run = await sync();

    expect(run.status).toBe("failed");
    expect(store.listPostsByCreator("cr_ana")).toHaveLength(1);
    expect(store.getConnection("conn_1")!.lastSyncedAt).toBeNull();

    provider.enqueue(page([raw("p1", 100)], "c1"), page([raw("p2", 20)]));
    const retry = await sync();
    expect(retry).toMatchObject({ status: "succeeded", postsCreated: 1, postsUnchanged: 1 });
    expect(totalViews(store)).toBe(120);
  });
});

describe("429: espera o Retry-After, com teto", () => {
  it("Retry-After em segundos: espera exatamente esse prazo pelo relógio", async () => {
    const { clock, sync, store } = setup([{ status: 429, headers: { "Retry-After": "5" } }, page([raw("p1", 100)])]);
    const run = await sync();

    expect(clock.sleeps).toEqual([5_000]);
    expect(run).toMatchObject({ status: "succeeded", requests: 2, waitedMs: 5_000 });
    expect(store.getPost("instagram", "p1")!.fetchedAt.toISOString()).toBe("2026-10-09T12:00:05.000Z");
  });

  it("Retry-After como HTTP-date: espera até a data indicada", async () => {
    const { clock, sync } = setup([
      { status: 429, headers: { "retry-after": "Fri, 09 Oct 2026 12:00:30 GMT" } },
      page([raw("p1", 100)]),
    ]);
    const run = await sync();
    expect(clock.sleeps).toEqual([30_000]);
    expect(run.status).toBe("succeeded");
  });

  it("Retry-After igual ao teto ainda espera", async () => {
    const { clock, sync } = setup([{ status: 429, headers: { "Retry-After": "60" } }, page([])]);
    expect((await sync()).status).toBe("succeeded");
    expect(clock.sleeps).toEqual([60_000]);
  });

  it("Retry-After acima do teto: não espera, não insiste, e registra quando tentar de novo", async () => {
    const { clock, provider, sync, store } = setup([{ status: 429, headers: { "Retry-After": "3600" } }, page([])]);
    const run = await sync();

    expect(clock.sleeps).toEqual([]);
    expect(provider.calls).toHaveLength(1);
    expect(run.status).toBe("rate_limited");
    expect(run.error).toContain("passa do teto de 60s");
    expect(run.retryAfterAt!.toISOString()).toBe("2026-10-09T13:00:00.000Z");
    expect(store.getConnection("conn_1")!.lastSyncedAt).toBeNull();
  });

  it("429 sem Retry-After usa o backoff", async () => {
    const { clock, sync } = setup([{ status: 429 }, page([])]);
    await sync();
    expect(clock.sleeps).toEqual([1_000]);
  });

  it("429 seguidos também param no teto de tentativas", async () => {
    const script: ScriptStep[] = Array.from({ length: 6 }, () => ({ status: 429, headers: { "Retry-After": "1" } }));
    const { clock, sync } = setup(script);
    const run = await sync();

    expect(run).toMatchObject({ status: "rate_limited", requests: 4 });
    expect(clock.sleeps).toEqual([1_000, 1_000, 1_000]);
  });
});

describe("quando a métrica foi buscada", () => {
  it("fetched_at por snapshot e last_synced_at na conexão", async () => {
    const { clock, sync, store } = setup([
      page([raw("p1", 100)], "c1"),
      { status: 503 },
      page([raw("p2", 50)]),
    ]);
    const run = await sync();

    expect(store.listSnapshots("instagram", "p1")[0]).toMatchObject({
      fetchedAt: new Date(START),
      syncRunId: run.id,
    });
    expect(store.listSnapshots("instagram", "p2")[0]!.fetchedAt.toISOString()).toBe("2026-10-09T12:00:01.000Z");
    expect(store.getConnection("conn_1")!.lastSyncedAt).toEqual(clock.now());
    expect(run.finishedAt).toEqual(clock.now());
    expect(store.listSyncRuns("conn_1")[0]).toMatchObject({ id: run.id, status: "succeeded" });
  });
});

describe("fronteira com o provedor", () => {
  it("a regra de sync funciona com qualquer MetricsProvider, sem HTTP", async () => {
    const { deps, store, clock } = setup();
    let calls = 0;
    const provider: MetricsProvider = {
      async listPosts() {
        calls += 1;
        if (calls === 1) throw new ProviderError("rate_limited", "cota esgotada", 2_000);
        return { posts: [{ postId: "v1", publishedAt: "2026-10-02T00:00:00.000Z", views: 9, likes: 1, comments: 0 }], nextCursor: null };
      },
    };
    const run = await syncConnection({ ...deps, providers: { instagram: provider } }, store.getConnection("conn_1")!, WINDOW);

    expect(run.status).toBe("succeeded");
    expect(clock.sleeps).toEqual([2_000]);
    expect(store.getPost("instagram", "v1")!.views).toBe(9);
  });

  it("cursor repetido pelo provedor encerra a sync em vez de girar em loop", async () => {
    const { sync } = setup([page([raw("p1", 1)], "c1"), page([raw("p2", 1)], "c1"), page([])]);
    const run = await sync();
    expect(run.status).toBe("failed");
    expect(run.error).toContain("cursor c1 repetido");
  });

  it("não deixa duas syncs da mesma conexão rodarem ao mesmo tempo", async () => {
    const { sync } = setup([page([raw("p1", 1)]), page([raw("p1", 1)])]);
    const first = sync();
    await expect(sync()).rejects.toBeInstanceOf(SyncInProgressError);
    expect((await first).status).toBe("succeeded");
    expect((await sync()).status).toBe("succeeded");
  });
});
