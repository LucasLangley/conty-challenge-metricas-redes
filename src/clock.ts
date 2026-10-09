export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  // Prazo que corre em paralelo a outra operação: resolve depois de `ms`, a não
  // ser que `signal` aborte antes. Abortado, o timer é limpo e a promise nunca resolve.
  timeout(ms: number, signal: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeout: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return;
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    }),
};
