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

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type SyncDeps = {
  store: Store;
  providers: Partial<Record<ProviderName, MetricsProvider>>;
  clock: Clock;
  retry: RetryPolicy;
  maxPages: number;
  // Prazo de cada chamada ao provedor. Padrão: DEFAULT_REQUEST_TIMEOUT_MS.
  requestTimeoutMs?: number;
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
    // Erro inesperado (bug, store fora do ar) sobe para quem chamou, mas a
    // execução já fica fechada como failed pelo finally.
    if (!(err instanceof ProviderError)) throw err;
  } finally {
    // Uma sync nunca termina como running: se algo escapou de tudo acima, ela
    // fecha como failed e a próxima sync da conexão não recebe 409.
    if (run.status === "running") {
      run.status = "failed";
      run.finishedAt ??= clock.now();
      run.error ??= "sync interrompida por erro inesperado";
    }
    store.updateSyncRun(run);
  }
  return run;
}

async function fetchPage(
  deps: SyncDeps,
  provider: MetricsProvider,
  run: SyncRun,
  request: ListPostsRequest,
): Promise<PostPage> {
  const timeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  for (let attempt = 1; ; attempt++) {
    run.requests += 1;
    try {
      return await withDeadline(deps.clock, timeoutMs, (signal) => provider.listPosts(request, signal));
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

// Cada chamada ao provedor tem prazo. Se o prazo vence primeiro, a chamada vira
// falha transitória (entra no mesmo retry com teto) e o signal é abortado para o
// provedor largar a requisição. Uma resposta que chegue depois é ignorada.
function withDeadline<T>(clock: Clock, timeoutMs: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    void clock.timeout(timeoutMs, controller.signal).then(() => {
      const error = new ProviderError("transient", `provedor não respondeu em ${timeoutMs / 1000}s (timeout)`);
      reject(error);
      controller.abort(error);
    });
    call(controller.signal).then(resolve, reject);
  }).finally(() => controller.abort());
}

// O mesmo post pode chegar várias vezes: repetido na página, em outra página
// ou numa janela que se sobrepõe à anterior. A chave é provider + postId, e o
// valor guardado é sempre o absoluto mais recente; um snapshot só entra no
// histórico quando os números mudaram. Mesmo sem mudança, o post registra que
// foi conferido agora (lastCheckedAt), para não parecer dado velho.
function applyPost(store: Store, connection: Connection, run: SyncRun, item: ProviderPost, fetchedAt: Date): void {
  run.postsReceived += 1;
  const current = store.getPost(connection.provider, item.postId);
  const decision = decideSnapshot(current, item);
  const checked = { lastCheckedAt: fetchedAt, lastCheckedSyncRunId: run.id };
  if (decision === "unchanged") {
    store.savePost({ ...current!, ...checked });
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
    ...checked,
  });
  store.appendSnapshot({ provider: connection.provider, postId: item.postId, ...values, fetchedAt, syncRunId: run.id });
  if (decision === "created") run.postsCreated += 1;
  else run.postsUpdated += 1;
}
