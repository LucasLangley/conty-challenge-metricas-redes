# Métricas das redes do criador

Serviço que recebe uma conexão já autorizada (token fictício) com Instagram, TikTok, YouTube ou X e sincroniza as métricas dos posts (views, curtidas, comentários). Não há OAuth nem rede: os quatro provedores são simulados.

## Como rodar

```bash
npm install
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm start          # http://127.0.0.1:3004 (PORT muda a porta)
```

Node 22. Os dados ficam em memória e somem quando o processo para.

No `npm start`, cada provedor simulado tem 5 posts publicados nas últimas 60 horas, 2 por página, para as contas `ig_ana`, `tt_ana`, `yt_ana` e `x_ana`. A primeira sync de três deles passa por um erro de propósito: TikTok responde 429 com `Retry-After: 2`, YouTube responde 429 com `Retry-After: 3600` (acima do teto) e X responde 503.

## Estrutura

| Arquivo | Papel |
|---|---|
| `src/domain/metrics.ts` | tipos e a regra pura `decideSnapshot` (novo, igual ou atualizado) |
| `src/domain/retry.ts` | política de retry pura: backoff, teto de tentativas, teto do Retry-After |
| `src/domain/provider.ts` | interface `MetricsProvider` e `ProviderError` (`transient`, `rate_limited`, `fatal`) |
| `src/domain/sync.ts` | a sync: pagina, aplica a regra, faz retry, registra a execução |
| `src/providers/http-response.ts` | traduz status, headers e corpo do provedor para o domínio; lê o `Retry-After` |
| `src/providers/fake.ts` | `FakeProvider`: roteiro de respostas e, depois dele, catálogo paginado |
| `src/store.ts` | interface `Store` e a implementação em memória |
| `src/app.ts` / `src/index.ts` | rotas Hono / `serve()` com os provedores simulados |

A sync só conhece `MetricsProvider` e `ProviderError`. Status HTTP, header `Retry-After` e formato do corpo ficam em `src/providers/`. Um adaptador real (Graph API, TikTok API, etc.) implementaria a mesma interface usando `toPostPage`. Um dos testes roda a sync com um provedor escrito à mão, sem nenhum HTTP.

## Regras

**Idempotência: o mesmo post chegando de novo.** A chave natural é `provider + post_id`. O provedor manda o total acumulado de cada post, e é esse valor absoluto que guardamos. Nunca somamos diferenças. Para cada post recebido:

- chave nova: cria o post e grava o primeiro snapshot;
- mesma chave e mesmos três números: não faz nada (nem post, nem snapshot, nem `fetched_at` mudam);
- mesma chave com outro número: substitui o valor atual e acrescenta um snapshot ao histórico.

Isso vale do mesmo jeito para o post repetido na mesma página, em outra página da mesma sync ou numa sync cuja janela se sobrepõe à anterior. Com `[t0,t2]` e depois `[t1,t3]`, os posts de `[t1,t2]` chegam duas vezes. Na segunda vez eles caem em "igual" (ou em "atualizado", se o número mudou) e o total do criador não dobra. O histórico só compara com o último snapshot do post: se um número cai e depois volta ao valor antigo, cada mudança vira um snapshot.

**Janela.** O provedor devolve os posts *publicados* dentro de `[since, until]`. Sem corpo, a sync usa os últimos 7 dias até agora. Sobrepor janelas é esperado e seguro.

**Paginação.** A sync segue `next_cursor` até vir `null`. Ela falha se o provedor repetir um cursor (evita loop) ou se passar de `maxPages` (100 no servidor). Cada página é gravada assim que chega. Se a página 3 falhar, as páginas 1 e 2 já estão salvas e repetir a sync não duplica nada.

**Falha transitória (timeout, 408, 5xx).** Repete com backoff exponencial: 1s, 2s, 4s… até 30s por espera e no máximo 4 chamadas por página. Depois disso a sync termina como `failed`. Erro definitivo (401, 403, 404, corpo inválido, contagem negativa) não tem retry.

**429.**
- Com `Retry-After` em segundos (`"5"`) ou HTTP-date (`"Fri, 09 Oct 2026 12:00:30 GMT"`), a sync espera exatamente esse prazo, usando o `sleep` do `Clock`.
- Data no passado vira espera zero.
- Valor ilegível conta como ausente. Só o formato IMF-fixdate é aceito; os formatos obsoletos da RFC não.
- Sem `Retry-After`, usa o backoff normal.
- Cada 429 conta no mesmo teto de 4 chamadas por página.

**Retry-After acima do teto (60s).** A sync não espera e não tenta antes da hora. Ela termina como `rate_limited`, guarda `retry_after_at` (quando o provedor volta a aceitar) e a API responde 503 com o mesmo `Retry-After`. Escolhi isso porque esperar uma hora prenderia o worker, e tentar antes do prazo só gastaria cota e arriscaria bloqueio. Quem agenda as syncs decide quando voltar.

**Quando a métrica foi buscada.**
- Cada snapshot tem `fetched_at`, que é o momento em que a página chegou, e o `sync_run_id` que o trouxe.
- O post mostra o `fetched_at` do valor atual.
- A conexão tem `last_synced_at`, que só muda quando a sync termina com sucesso.
- Toda execução fica em `/connections/:id/sync-runs` com janela, páginas, chamadas, tempo esperado, contadores e erro.

**Concorrência.** Uma sync por conexão de cada vez; a segunda recebe 409. A regra continuaria correta com duas, mas elas disputariam a cota do provedor.

**Tempo.** Tudo que depende de tempo usa `Clock` (`now` e `sleep`). Nos testes, `ManualClock.sleep` não espera: avança o relógio e anota o pedido. Por isso os testes de 429 checam `sleeps` como `[5000]` e `[30000]` sem esperar de verdade.

## Endpoints

Exemplos gerados rodando `npm start` e chamando a API. Os ids são UUIDs aleatórios. Alguns campos foram cortados com `…`; os valores mostrados são os que vieram.

### `POST /connections`

```http
POST /connections
{"creator_id":"cr_ana","provider":"instagram","external_account_id":"ig_ana","access_token":"tok_demo"}
```
```json
HTTP 201
{
  "id": "conn_69bb93c0-91fa-4843-8a31-a03a3f3e49fa",
  "creator_id": "cr_ana",
  "provider": "instagram",
  "external_account_id": "ig_ana",
  "created_at": "2026-10-09T15:21:34.356Z",
  "last_synced_at": null
}
```

O token nunca volta na resposta. Conectar a mesma conta de novo devolve a conexão existente (200), ou 409 se ela pertence a outro criador. `provider` inválido dá 400 com `{"error":"provider deve ser instagram, tiktok, youtube ou x"}`.

### `POST /connections/:id/sync`

Corpo opcional `{"since": ISO, "until": ISO}`. Respostas: 200 quando a sync termina com sucesso, 502 quando falha, 503 + `Retry-After` quando fica `rate_limited`, 409 se já houver uma sync rodando.

Primeira sync, sem corpo (últimos 7 dias, 3 páginas):

```json
HTTP 200
{
  "id": "run_8748f33f-ffda-4c9a-8592-ff016e3ab233",
  "connection_id": "conn_69bb93c0-91fa-4843-8a31-a03a3f3e49fa",
  "window": { "since": "2026-10-02T15:21:34.365Z", "until": "2026-10-09T15:21:34.365Z" },
  "status": "succeeded",
  "started_at": "2026-10-09T15:21:34.365Z",
  "finished_at": "2026-10-09T15:21:34.366Z",
  "pages": 3,
  "requests": 3,
  "waited_ms": 0,
  "posts_received": 5,
  "posts_created": 5,
  "posts_updated": 0,
  "posts_unchanged": 0,
  "error": null,
  "retry_after_at": null
}
```

Segunda sync com janela sobreposta. Os 3 posts dela já tinham vindo na primeira, com os mesmos números:

```http
POST /connections/conn_69bb93c0-…/sync
{"since":"2026-10-07T23:21:34.367Z","until":"2026-10-09T15:21:34.367Z"}
```
```json
HTTP 200
{
  "id": "run_dd207204-31b0-41fc-98de-4e054bd7b733",
  "status": "succeeded",
  "pages": 2,
  "requests": 2,
  "posts_received": 3,
  "posts_created": 0,
  "posts_updated": 0,
  "posts_unchanged": 3,
  …
}
```

TikTok, com 429 e `Retry-After: 2` na primeira chamada: esperou 2s e seguiu.

```json
HTTP 200
{
  "status": "succeeded",
  "started_at": "2026-10-09T15:21:34.390Z",
  "finished_at": "2026-10-09T15:21:36.400Z",
  "pages": 3,
  "requests": 4,
  "waited_ms": 2000,
  "posts_created": 5,
  …
}
```

YouTube, com 429 e `Retry-After: 3600`, acima do teto de 60s:

```json
HTTP 503  Retry-After: 3600
{
  "id": "run_360a40f2-811c-487a-8e75-030468d77e6a",
  "status": "rate_limited",
  "started_at": "2026-10-09T15:21:36.406Z",
  "finished_at": "2026-10-09T15:21:36.406Z",
  "pages": 0,
  "requests": 1,
  "waited_ms": 0,
  "error": "provedor respondeu 429; espera pedida de 3600s passa do teto de 60s",
  "retry_after_at": "2026-10-09T16:21:36.406Z",
  …
}
```

X, com 503 na primeira chamada: backoff de 1s e seguiu (`"requests": 4`, `"waited_ms": 1000`, `"status": "succeeded"`).

### `GET /creators/:id/posts`

Métricas atuais e quando foram buscadas, do post publicado mais recente ao mais antigo (trecho: 1 de 5 posts).

```json
HTTP 200
{
  "creator_id": "cr_ana",
  "posts": [
    {
      "provider": "instagram",
      "post_id": "ig_1",
      "connection_id": "conn_69bb93c0-91fa-4843-8a31-a03a3f3e49fa",
      "published_at": "2026-10-09T03:21:23.367Z",
      "views": 5000,
      "likes": 400,
      "comments": 35,
      "fetched_at": "2026-10-09T15:21:34.366Z"
    },
    …
  ]
}
```

### `GET /posts/:provider/:postId/snapshots`

Histórico de snapshots. `ig_1` veio nas duas syncs acima e tem um snapshot só:

```json
HTTP 200
{
  "provider": "instagram",
  "post_id": "ig_1",
  "views": 5000,
  "fetched_at": "2026-10-09T15:21:34.366Z",
  "snapshots": [
    { "views": 5000, "likes": 400, "comments": 35, "fetched_at": "2026-10-09T15:21:34.366Z", "sync_run_id": "run_8748f33f-ffda-4c9a-8592-ff016e3ab233" }
  ],
  …
}
```

### `GET /connections/:id/sync-runs` e `GET /connections/:id`

`sync-runs` lista as execuções da mais recente para a mais antiga, no mesmo formato da resposta de sync: `{"connection_id": "...", "runs": [ ... ]}`. A conexão mostra a última sync bem-sucedida:

```json
HTTP 200
{
  "id": "conn_69bb93c0-91fa-4843-8a31-a03a3f3e49fa",
  "creator_id": "cr_ana",
  "provider": "instagram",
  "external_account_id": "ig_ana",
  "created_at": "2026-10-09T15:21:34.356Z",
  "last_synced_at": "2026-10-09T15:21:34.370Z"
}
```

## Testes

- `test/sync.test.ts`: a sync com `FakeProvider` roteirizado e `ManualClock`. Cobre:
  - post repetido na mesma página e em outra página;
  - janelas `[t0,t2]` e `[t1,t3]`, com números iguais e com número novo (substitui, não soma);
  - sync idêntica não grava nada;
  - timeout e 5xx com backoff e teto de tentativas;
  - 401 sem retry;
  - falha na página 2 seguida de nova sync;
  - 429 com segundos, com HTTP-date, no teto, acima do teto e sem header;
  - 429 seguidos;
  - `fetched_at` e `last_synced_at`;
  - provedor sem HTTP, cursor repetido e syncs concorrentes.
- `test/provider-boundary.test.ts`: `parseRetryAfter`, a tradução da resposta do provedor, `decideRetry` e `decideSnapshot`.
- `test/api.test.ts`: as rotas via `app.request`, incluindo as janelas sobrepostas e o 503 com `Retry-After`.

## O que ficou de fora / faria com mais tempo

- **Persistência real.** A `Store` em memória atrás de uma interface. Com SQLite/Postgres, a chave `(provider, post_id)` viraria `UNIQUE`, o upsert seria `INSERT … ON CONFLICT DO UPDATE … WHERE` os números mudaram, e post + snapshot iriam na mesma transação.
- **Agendador.** Nada reexecuta sozinho as syncs `rate_limited` em `retry_after_at`, nem roda syncs periódicas por conexão.
- **Timeout de verdade.** O provedor simulado só sinaliza "timeout". Um adaptador real usaria `AbortSignal.timeout` no `fetch` e traduziria para `ProviderError("transient")`.
- **Jitter no backoff.** Ficou determinístico para os testes serem exatos. Em produção eu somaria jitter vindo de uma fonte aleatória injetada.
- **Cota compartilhada.** O limite de taxa é por app/token no provedor. Com muitas conexões, eu colocaria um limitador por provedor antes das chamadas, em vez de só reagir ao 429.
- **Métrica que diminui.** Hoje é aceita como veio (curtida removida existe). Eu marcaria quedas grandes para revisão, sem bloquear.
- **Token.** Fica em memória, em texto puro. Num serviço real ele seria cifrado, e o refresh do OAuth estaria em outro módulo.

## Uso de IA

Implementação, testes e README escritos com Claude Code (IA da Anthropic) a partir do enunciado. O que eu revisei: _(a preencher)_
