import type { Clock } from "../clock.ts";
import type { Store } from "../store.ts";
import { type Connection, type ProviderName, type SyncRun, decideSnapshot } from "./metrics.ts";
import {
  type ListPostsRequest,
  type MetricsProvider,
  type PostPage,
  type ProviderPost,
  ProviderError,
} from "./provider.ts";
import { type RetryPolicy, decideRetry } from "./retry.ts";

export type SyncDeps = {
  store: Store;
  providers: Partial<Record<ProviderName, MetricsProvider>>;
  clock: Clock;
  retry: RetryPolicy;
  maxPages: number;
};

export type SyncWindow = { since: Date; until: Date };

export class SyncInProgressError extends Error {
  constructor(connectionId: string) {
    super(`já existe uma sincronização em andamento para ${connectionId}`);
  }
}

export async function syncConnection(deps: SyncDeps, connection: Connection, window: SyncWindow): Promise<SyncRun> {
  const { store, clock } = deps;
  // Uma sync por conexão de cada vez: duas syncs simultâneas não quebrariam a
  // contagem (a regra é idempotente), mas disputariam o limite de taxa do provedor.
  if (store.listSyncRuns(connection.id).some((r) => r.status === "running")) {
    throw new SyncInProgressError(connection.id);
  }
  const run: SyncRun = {
    id: `run_${crypto.randomUUID()}`,
    connectionId: connection.id,
    since: window.since,
    until: window.until,
    status: "running",
    startedAt: clock.now(),
    finishedAt: null,
    pages: 0,
    requests: 0,
    waitedMs: 0,
    postsReceived: 0,
    postsCreated: 0,
    postsUpdated: 0,
    postsUnchanged: 0,
    error: null,
    retryAfterAt: null,
  };
  store.insertSyncRun(run);

  try {
    const provider = deps.providers[connection.provider];
    if (!provider) throw new ProviderError("fatal", `provedor ${connection.provider} não configurado`);

    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      if (run.pages >= deps.maxPages) throw new ProviderError("fatal", `passou de ${deps.maxPages} páginas`);
      const page = await fetchPage(deps, provider, run, {
        accountId: connection.externalAccountId,
        accessToken: connection.accessToken,
        since: window.since,
        until: window.until,
        cursor,
      });
      run.pages += 1;
      const fetchedAt = clock.now();
      for (const item of page.posts) applyPost(store, connection, run, item, fetchedAt);
      store.updateSyncRun(run);

      cursor = page.nextCursor;
      if (cursor !== null) {
        if (seenCursors.has(cursor)) throw new ProviderError("fatal", `cursor ${cursor} repetido pelo provedor`);
        seenCursors.add(cursor);
      }
    } while (cursor !== null);

    run.status = "succeeded";
    run.finishedAt = clock.now();
    store.updateConnection({ ...connection, lastSyncedAt: run.finishedAt });
  } catch (err) {
    run.finishedAt = clock.now();
    run.error = err instanceof Error ? err.message : String(err);
    run.status = err instanceof ProviderError && err.kind === "rate_limited" ? "rate_limited" : "failed";
    if (err instanceof ProviderError && err.retryAfterMs !== null) {
      run.retryAfterAt = new Date(run.finishedAt.getTime() + err.retryAfterMs);
    }
    store.updateSyncRun(run);
    if (!(err instanceof ProviderError)) throw err;
    return run;
  }
  store.updateSyncRun(run);
  return run;
}

async function fetchPage(
  deps: SyncDeps,
  provider: MetricsProvider,
  run: SyncRun,
  request: ListPostsRequest,
): Promise<PostPage> {
  for (let attempt = 1; ; attempt++) {
    run.requests += 1;
    try {
      return await provider.listPosts(request);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      const decision = decideRetry(err, attempt, deps.retry);
      if (!decision.retry) {
        const overCap = err.retryAfterMs !== null && err.retryAfterMs > deps.retry.maxRetryAfterMs;
        const reason = overCap
          ? `espera pedida de ${err.retryAfterMs! / 1000}s passa do teto de ${deps.retry.maxRetryAfterMs / 1000}s`
          : `desistiu após ${attempt} tentativa(s)`;
        throw new ProviderError(err.kind, `${err.message}; ${reason}`, err.retryAfterMs);
      }
      run.waitedMs += decision.waitMs;
      await deps.clock.sleep(decision.waitMs);
    }
  }
}

// O mesmo post pode chegar várias vezes: repetido na página, em outra página
// ou numa janela que se sobrepõe à anterior. A chave é provider + postId, e o
// valor guardado é sempre o absoluto mais recente; um snapshot só entra no
// histórico quando os números mudaram.
function applyPost(store: Store, connection: Connection, run: SyncRun, item: ProviderPost, fetchedAt: Date): void {
  run.postsReceived += 1;
  const current = store.getPost(connection.provider, item.postId);
  const decision = decideSnapshot(current, item);
  if (decision === "unchanged") {
    run.postsUnchanged += 1;
    return;
  }
  const values = { views: item.views, likes: item.likes, comments: item.comments };
  store.savePost({
    provider: connection.provider,
    postId: item.postId,
    creatorId: connection.creatorId,
    connectionId: connection.id,
    publishedAt: item.publishedAt,
    ...values,
    fetchedAt,
  });
  store.appendSnapshot({ provider: connection.provider, postId: item.postId, ...values, fetchedAt, syncRunId: run.id });
  if (decision === "created") run.postsCreated += 1;
  else run.postsUpdated += 1;
}
