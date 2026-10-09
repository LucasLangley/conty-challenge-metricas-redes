export const PROVIDERS = ["instagram", "tiktok", "youtube", "x"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export type MetricValues = { views: number; likes: number; comments: number };

export type Connection = {
  id: string;
  creatorId: string;
  provider: ProviderName;
  externalAccountId: string;
  accessToken: string;
  createdAt: Date;
  lastSyncedAt: Date | null;
};

// Valor absoluto mais recente do post. A chave natural é provider + postId.
// `fetchedAt` é quando chegou o valor atual (o do snapshot vigente);
// `lastCheckedAt` é a última vez que o provedor mandou o post, mesmo sem mudança.
export type Post = MetricValues & {
  provider: ProviderName;
  postId: string;
  creatorId: string;
  connectionId: string;
  publishedAt: string;
  fetchedAt: Date;
  lastCheckedAt: Date;
  lastCheckedSyncRunId: string;
};

export type Snapshot = MetricValues & {
  provider: ProviderName;
  postId: string;
  fetchedAt: Date;
  syncRunId: string;
};

export type SyncRunStatus = "running" | "succeeded" | "failed" | "rate_limited";

export type SyncRun = {
  id: string;
  connectionId: string;
  since: Date;
  until: Date;
  status: SyncRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  pages: number;
  requests: number;
  waitedMs: number;
  postsReceived: number;
  postsCreated: number;
  postsUpdated: number;
  postsUnchanged: number;
  error: string | null;
  retryAfterAt: Date | null;
};

export type SnapshotDecision = "created" | "updated" | "unchanged";

// O provedor manda o total acumulado, não o incremento. Por isso nunca somamos:
// o mesmo post chegando de novo (mesma página, outra página ou outra janela)
// com os mesmos números não muda nada, e com números diferentes substitui.
export function decideSnapshot(current: MetricValues | undefined, incoming: MetricValues): SnapshotDecision {
  if (!current) return "created";
  const same =
    current.views === incoming.views && current.likes === incoming.likes && current.comments === incoming.comments;
  return same ? "unchanged" : "updated";
}
