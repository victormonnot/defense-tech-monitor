import { collectScheduledSources } from "./collector";

const globals = globalThis as typeof globalThis & {
  collectionScheduler?: ReturnType<typeof setInterval>;
  collectionSchedulerBusy?: boolean;
};

export function startCollectionScheduler() {
  if (globals.collectionScheduler) return;
  const tick = async () => {
    if (globals.collectionSchedulerBusy) return;
    globals.collectionSchedulerBusy = true;
    try {
      await collectScheduledSources();
    } catch (error) {
      console.error(
        "Automatic collection failed:",
        error instanceof Error ? error.message : "Unknown collection error",
      );
    } finally {
      globals.collectionSchedulerBusy = false;
    }
  };
  globals.collectionScheduler = setInterval(() => {
    void tick();
  }, 10000);
  globals.collectionScheduler.unref();
  void tick();
}
