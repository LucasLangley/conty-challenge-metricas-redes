import type { Clock } from "../../src/clock.ts";

// Relógio dos testes: sleep não espera de verdade, só avança o tempo e anota quanto foi pedido.
export class ManualClock implements Clock {
  readonly sleeps: number[] = [];
  // Prazos (timeout) que venceram, na ordem.
  readonly expired: number[] = [];
  private current: number;

  constructor(start: string) {
    this.current = Date.parse(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
  }

  // O prazo vence no próximo setImmediate, depois que a fila de microtasks
  // esvazia: um provedor que responde (mesmo com vários await) sempre ganha, e
  // um que nunca responde perde sem espera real. Ao vencer, o relógio anda o
  // prazo inteiro, como se o tempo tivesse passado.
  timeout(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return;
      const timer = setImmediate(() => {
        this.expired.push(ms);
        this.current += ms;
        resolve();
      });
      signal.addEventListener("abort", () => clearImmediate(timer), { once: true });
    });
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(at: string): void {
    this.current = Date.parse(at);
  }
}
