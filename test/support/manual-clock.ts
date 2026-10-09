import type { Clock } from "../../src/clock.ts";

// Relógio dos testes: sleep não espera de verdade, só avança o tempo e anota quanto foi pedido.
export class ManualClock implements Clock {
  readonly sleeps: number[] = [];
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

  advance(ms: number): void {
    this.current += ms;
  }

  set(at: string): void {
    this.current = Date.parse(at);
  }
}
