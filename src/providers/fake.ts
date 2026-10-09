import type { Clock } from "../clock.ts";
import { type ListPostsRequest, type MetricsProvider, type PostPage, ProviderError } from "../domain/provider.ts";
import { type HttpLikeResponse, type RawPost, toPostPage } from "./http-response.ts";

export type ScriptStep = HttpLikeResponse | { timeout: true };

export type FakeCatalog = { postsByAccount: Record<string, RawPost[]>; pageSize: number };

// Provedor simulado. Cada chamada consome o próximo passo do roteiro; com o
// roteiro vazio, responde a partir do catálogo, paginando por cursor e filtrando
// pela data de publicação dentro da janela.
export class FakeProvider implements MetricsProvider {
  readonly calls: ListPostsRequest[] = [];
  private script: ScriptStep[];

  constructor(
    private clock: Clock,
    script: ScriptStep[] = [],
    private catalog?: FakeCatalog,
  ) {
    this.script = [...script];
  }

  enqueue(...steps: ScriptStep[]): void {
    this.script.push(...steps);
  }

  get pending(): number {
    return this.script.length;
  }

  async listPosts(request: ListPostsRequest): Promise<PostPage> {
    this.calls.push({ ...request });
    const step = this.script.shift() ?? this.fromCatalog(request);
    if ("timeout" in step) throw new ProviderError("transient", "provedor não respondeu no prazo (timeout)");
    return toPostPage(step, this.clock.now());
  }

  private fromCatalog(request: ListPostsRequest): HttpLikeResponse {
    if (!this.catalog) throw new Error("roteiro do provedor falso acabou e não há catálogo");
    const inWindow = (this.catalog.postsByAccount[request.accountId] ?? []).filter((p) => {
      const at = Date.parse(p.published_at);
      return at >= request.since.getTime() && at <= request.until.getTime();
    });
    const offset = request.cursor === null ? 0 : Number(request.cursor);
    const end = offset + this.catalog.pageSize;
    return {
      status: 200,
      body: { data: inWindow.slice(offset, end), next_cursor: end < inWindow.length ? String(end) : null },
    };
  }
}
