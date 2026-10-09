import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { type FakeCatalog, FakeProvider } from "../src/providers/fake.ts";
import { MemoryStore } from "../src/store.ts";
import { ManualClock } from "./support/manual-clock.ts";

type App = ReturnType<typeof createApp>;
type Json = Record<string, any>;

function setup() {
  const clock = new ManualClock("2026-10-09T12:00:00.000Z");
  const catalog: FakeCatalog = {
    pageSize: 2,
    postsByAccount: {
      ig_ana: [
        { id: "a", published_at: "2026-10-02T00:00:00.000Z", view_count: 100, like_count: 10, comment_count: 1 },
        { id: "b", published_at: "2026-10-04T00:00:00.000Z", view_count: 200, like_count: 20, comment_count: 2 },
        { id: "c", published_at: "2026-10-06T00:00:00.000Z", view_count: 300, like_count: 30, comment_count: 3 },
      ],
    },
  };
  const instagram = new FakeProvider(clock, [], catalog);
  const youtube = new FakeProvider(clock, [{ status: 429, headers: { "Retry-After": "3600" } }]);
  const app = createApp({
    store: new MemoryStore(),
    providers: { instagram, youtube },
    clock,
    retry: { maxAttempts: 3, baseDelayMs: 1_000, maxBackoffMs: 10_000, maxRetryAfterMs: 60_000 },
    maxPages: 20,
    defaultWindowDays: 7,
  });
  return { app, clock, instagram };
}

async function post(app: App, path: string, body?: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Json };
}

async function get(app: App, path: string) {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as Json };
}

async function connect(app: App, provider = "instagram", account = "ig_ana") {
  return post(app, "/connections", {
    creator_id: "cr_ana",
    provider,
    external_account_id: account,
    access_token: "tok_fake_123",
  });
}

describe("POST /connections", () => {
  it("cria a conexão sem devolver o token", async () => {
    const { app } = setup();
    const res = await connect(app);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ creator_id: "cr_ana", provider: "instagram", last_synced_at: null });
    expect(JSON.stringify(res.body)).not.toContain("tok_fake_123");
  });

  it("conectar a mesma conta de novo devolve a conexão existente", async () => {
    const { app } = setup();
    const first = await connect(app);
    const again = await connect(app);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
  });

  it("valida provider e campos obrigatórios", async () => {
    const { app } = setup();
    expect((await connect(app, "orkut")).status).toBe(400);
    expect((await post(app, "/connections", { provider: "x" })).status).toBe(400);
  });
});

describe("sync pela API", () => {
  it("janelas sobrepostas não duplicam e as métricas mostram fetched_at", async () => {
    const { app, clock } = setup();
    const { body: conn } = await connect(app);

    const first = await post(app, `/connections/${conn.id}/sync`, {
      since: "2026-10-01T00:00:00.000Z",
      until: "2026-10-05T00:00:00.000Z",
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "succeeded", posts_created: 2 });

    clock.advance(30 * 60 * 1000);
    const second = await post(app, `/connections/${conn.id}/sync`, {
      since: "2026-10-03T00:00:00.000Z",
      until: "2026-10-07T00:00:00.000Z",
    });
    expect(second.body).toMatchObject({ status: "succeeded", posts_created: 1, posts_unchanged: 1 });

    const posts = await get(app, "/creators/cr_ana/posts");
    expect(posts.body.posts.map((p: Json) => [p.post_id, p.views, p.fetched_at])).toEqual([
      ["c", 300, "2026-10-09T12:30:00.000Z"],
      ["b", 200, "2026-10-09T12:00:00.000Z"],
      ["a", 100, "2026-10-09T12:00:00.000Z"],
    ]);

    const history = await get(app, "/posts/instagram/b/snapshots");
    expect(history.body.snapshots).toHaveLength(1);

    const connection = await get(app, `/connections/${conn.id}`);
    expect(connection.body.last_synced_at).toBe("2026-10-09T12:30:00.000Z");

    const runs = await get(app, `/connections/${conn.id}/sync-runs`);
    expect(runs.body.runs.map((r: Json) => r.id)).toEqual([second.body.id, first.body.id]);
  });

  it("sem corpo, usa os últimos 7 dias até agora", async () => {
    const { app, instagram } = setup();
    const { body: conn } = await connect(app);
    const res = await post(app, `/connections/${conn.id}/sync`);
    expect(res.body.window).toEqual({ since: "2026-10-02T12:00:00.000Z", until: "2026-10-09T12:00:00.000Z" });
    expect(instagram.calls[0]!.since.toISOString()).toBe("2026-10-02T12:00:00.000Z");
  });

  it("Retry-After acima do teto responde 503 com Retry-After e a sync fica registrada", async () => {
    const { app } = setup();
    const { body: conn } = await connect(app, "youtube", "yt_ana");
    const res = await post(app, `/connections/${conn.id}/sync`);

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("3600");
    expect(res.body).toMatchObject({ status: "rate_limited", retry_after_at: "2026-10-09T13:00:00.000Z" });
    const runs = await get(app, `/connections/${conn.id}/sync-runs`);
    expect(runs.body.runs[0].status).toBe("rate_limited");
  });

  it("janela inválida e conexão inexistente", async () => {
    const { app } = setup();
    const { body: conn } = await connect(app);
    const inverted = await post(app, `/connections/${conn.id}/sync`, {
      since: "2026-10-05T00:00:00.000Z",
      until: "2026-10-01T00:00:00.000Z",
    });
    expect(inverted.status).toBe(400);
    expect((await post(app, "/connections/nao-existe/sync")).status).toBe(404);
    expect((await get(app, "/connections/nao-existe/sync-runs")).status).toBe(404);
  });
});
