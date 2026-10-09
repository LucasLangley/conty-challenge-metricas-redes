import { Hono } from "hono";
import { type Connection, type Post, type Snapshot, type SyncRun, isProviderName } from "./domain/metrics.ts";
import { type SyncDeps, SyncInProgressError, syncConnection } from "./domain/sync.ts";

export type AppDeps = SyncDeps & { defaultWindowDays: number };

const DAY_MS = 24 * 60 * 60 * 1000;

const iso = (date: Date | null) => (date ? date.toISOString() : null);

function connectionJson(c: Connection) {
  return {
    id: c.id,
    creator_id: c.creatorId,
    provider: c.provider,
    external_account_id: c.externalAccountId,
    created_at: iso(c.createdAt),
    last_synced_at: iso(c.lastSyncedAt),
  };
}

function runJson(r: SyncRun) {
  return {
    id: r.id,
    connection_id: r.connectionId,
    window: { since: iso(r.since), until: iso(r.until) },
    status: r.status,
    started_at: iso(r.startedAt),
    finished_at: iso(r.finishedAt),
    pages: r.pages,
    requests: r.requests,
    waited_ms: r.waitedMs,
    posts_received: r.postsReceived,
    posts_created: r.postsCreated,
    posts_updated: r.postsUpdated,
    posts_unchanged: r.postsUnchanged,
    error: r.error,
    retry_after_at: iso(r.retryAfterAt),
  };
}

function postJson(p: Post) {
  return {
    provider: p.provider,
    post_id: p.postId,
    connection_id: p.connectionId,
    published_at: p.publishedAt,
    views: p.views,
    likes: p.likes,
    comments: p.comments,
    fetched_at: iso(p.fetchedAt),
  };
}

function snapshotJson(s: Snapshot) {
  return {
    views: s.views,
    likes: s.likes,
    comments: s.comments,
    fetched_at: iso(s.fetchedAt),
    sync_run_id: s.syncRunId,
  };
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const raw = await req.text();
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createApp(deps: AppDeps) {
  const { store, clock } = deps;
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/connections", async (c) => {
    const body = await readJson(c.req.raw);
    if (!body) return c.json({ error: "corpo inválido" }, 400);
    const creatorId = text(body.creator_id);
    const externalAccountId = text(body.external_account_id);
    const accessToken = text(body.access_token);
    if (!creatorId || !externalAccountId || !accessToken) {
      return c.json({ error: "creator_id, external_account_id e access_token são obrigatórios" }, 400);
    }
    if (!isProviderName(body.provider)) {
      return c.json({ error: "provider deve ser instagram, tiktok, youtube ou x" }, 400);
    }

    const existing = store.findConnection(body.provider, externalAccountId);
    if (existing) {
      if (existing.creatorId !== creatorId) return c.json({ error: "conta já conectada a outro criador" }, 409);
      store.updateConnection({ ...existing, accessToken });
      return c.json(connectionJson(existing), 200);
    }
    const connection: Connection = {
      id: `conn_${crypto.randomUUID()}`,
      creatorId,
      provider: body.provider,
      externalAccountId,
      accessToken,
      createdAt: clock.now(),
      lastSyncedAt: null,
    };
    store.insertConnection(connection);
    return c.json(connectionJson(connection), 201);
  });

  app.get("/connections/:id", (c) => {
    const connection = store.getConnection(c.req.param("id"));
    if (!connection) return c.json({ error: "conexão não encontrada" }, 404);
    return c.json(connectionJson(connection));
  });

  app.post("/connections/:id/sync", async (c) => {
    const connection = store.getConnection(c.req.param("id"));
    if (!connection) return c.json({ error: "conexão não encontrada" }, 404);
    const body = await readJson(c.req.raw);
    if (!body) return c.json({ error: "corpo inválido" }, 400);

    const until = body.until === undefined ? clock.now() : new Date(text(body.until));
    const since =
      body.since === undefined ? new Date(until.getTime() - deps.defaultWindowDays * DAY_MS) : new Date(text(body.since));
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
      return c.json({ error: "since e until devem ser datas ISO" }, 400);
    }
    if (since >= until) return c.json({ error: "since precisa ser anterior a until" }, 400);

    let run: SyncRun;
    try {
      run = await syncConnection(deps, connection, { since, until });
    } catch (err) {
      if (err instanceof SyncInProgressError) return c.json({ error: err.message }, 409);
      throw err;
    }
    if (run.status === "succeeded") return c.json(runJson(run), 200);
    if (run.status === "rate_limited") {
      if (run.retryAfterAt && run.finishedAt) {
        const seconds = Math.ceil((run.retryAfterAt.getTime() - run.finishedAt.getTime()) / 1000);
        c.header("Retry-After", String(seconds));
      }
      return c.json(runJson(run), 503);
    }
    return c.json(runJson(run), 502);
  });

  app.get("/connections/:id/sync-runs", (c) => {
    const connection = store.getConnection(c.req.param("id"));
    if (!connection) return c.json({ error: "conexão não encontrada" }, 404);
    return c.json({ connection_id: connection.id, runs: store.listSyncRuns(connection.id).map(runJson) });
  });

  app.get("/creators/:id/posts", (c) => {
    const creatorId = c.req.param("id");
    return c.json({ creator_id: creatorId, posts: store.listPostsByCreator(creatorId).map(postJson) });
  });

  app.get("/posts/:provider/:postId/snapshots", (c) => {
    const provider = c.req.param("provider");
    if (!isProviderName(provider)) return c.json({ error: "provider desconhecido" }, 400);
    const post = store.getPost(provider, c.req.param("postId"));
    if (!post) return c.json({ error: "post não encontrado" }, 404);
    return c.json({ ...postJson(post), snapshots: store.listSnapshots(provider, post.postId).map(snapshotJson) });
  });

  return app;
}
