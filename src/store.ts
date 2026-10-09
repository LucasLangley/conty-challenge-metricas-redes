import type { Connection, Post, ProviderName, Snapshot, SyncRun } from "./domain/metrics.ts";

export interface Store {
  insertConnection(connection: Connection): void;
  getConnection(id: string): Connection | undefined;
  findConnection(provider: ProviderName, externalAccountId: string): Connection | undefined;
  updateConnection(connection: Connection): void;

  getPost(provider: ProviderName, postId: string): Post | undefined;
  savePost(post: Post): void;
  listPostsByCreator(creatorId: string): Post[];

  appendSnapshot(snapshot: Snapshot): void;
  listSnapshots(provider: ProviderName, postId: string): Snapshot[];

  insertSyncRun(run: SyncRun): void;
  updateSyncRun(run: SyncRun): void;
  listSyncRuns(connectionId: string): SyncRun[];
}

const postKey = (provider: ProviderName, postId: string) => `${provider}:${postId}`;

export class MemoryStore implements Store {
  private connections = new Map<string, Connection>();
  private posts = new Map<string, Post>();
  private snapshots = new Map<string, Snapshot[]>();
  private runs = new Map<string, SyncRun>();

  insertConnection(connection: Connection): void {
    this.connections.set(connection.id, { ...connection });
  }

  getConnection(id: string): Connection | undefined {
    const found = this.connections.get(id);
    return found && { ...found };
  }

  findConnection(provider: ProviderName, externalAccountId: string): Connection | undefined {
    for (const c of this.connections.values()) {
      if (c.provider === provider && c.externalAccountId === externalAccountId) return { ...c };
    }
    return undefined;
  }

  updateConnection(connection: Connection): void {
    this.connections.set(connection.id, { ...connection });
  }

  getPost(provider: ProviderName, postId: string): Post | undefined {
    const found = this.posts.get(postKey(provider, postId));
    return found && { ...found };
  }

  savePost(post: Post): void {
    this.posts.set(postKey(post.provider, post.postId), { ...post });
  }

  listPostsByCreator(creatorId: string): Post[] {
    return [...this.posts.values()]
      .filter((p) => p.creatorId === creatorId)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .map((p) => ({ ...p }));
  }

  appendSnapshot(snapshot: Snapshot): void {
    const key = postKey(snapshot.provider, snapshot.postId);
    this.snapshots.set(key, [...(this.snapshots.get(key) ?? []), { ...snapshot }]);
  }

  listSnapshots(provider: ProviderName, postId: string): Snapshot[] {
    return (this.snapshots.get(postKey(provider, postId)) ?? []).map((s) => ({ ...s }));
  }

  insertSyncRun(run: SyncRun): void {
    this.runs.set(run.id, { ...run });
  }

  updateSyncRun(run: SyncRun): void {
    this.runs.set(run.id, { ...run });
  }

  listSyncRuns(connectionId: string): SyncRun[] {
    return [...this.runs.values()]
      .filter((r) => r.connectionId === connectionId)
      .reverse()
      .map((r) => ({ ...r }));
  }
}
