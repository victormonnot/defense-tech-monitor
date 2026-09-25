import { callJev, getJevConfig, JevRequestError } from "./jev-client";
import { claimJev, failJev, settleJev } from "./jev-store";
import type { MonitorStore } from "./store";

export async function processJevBatch(
  store: MonitorStore,
  options: {
    call?: typeof callJev;
    config?: () => ReturnType<typeof getJevConfig>;
    now?: () => number;
  } = {},
) {
  const call = options.call ?? callJev;
  const config = options.config ?? getJevConfig;
  const now = options.now ?? Date.now;
  let processed = 0;
  for (let index = 0; index < 5; index++) {
    const current = config();
    const claim = claimJev(store, current, now());
    if (!claim) break;
    processed++;
    try {
      const result = await call(claim.request, current.apiKey!);
      if (!settleJev(store, claim, result, now())) break;
    } catch (error) {
      const known = error instanceof JevRequestError;
      failJev(
        store,
        claim,
        known
          ? error.message
          : "L’analyse Jev a échoué. Une reprise explicite est nécessaire.",
        known && error.beforeRequest,
        now(),
      );
      break;
    }
  }
  return processed;
}

const globals = globalThis as typeof globalThis & {
  jevWorker?: ReturnType<typeof setInterval>;
  jevWorkerBusy?: boolean;
};
export function startJevWorker() {
  if (globals.jevWorker) return;
  const tick = async () => {
    if (globals.jevWorkerBusy) return;
    globals.jevWorkerBusy = true;
    try {
      const { getStore } = await import("./store");
      await processJevBatch(getStore());
    } catch {
      console.error("Jev background processing could not complete.");
    } finally {
      globals.jevWorkerBusy = false;
    }
  };
  globals.jevWorker = setInterval(() => {
    void tick();
  }, 10000);
  globals.jevWorker.unref();
  void tick();
}
