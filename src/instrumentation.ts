export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    const { startCollectionScheduler } =
      await import("./lib/collection-scheduler");
    startCollectionScheduler();
    const { startJevWorker } = await import("./lib/jev-worker");
    startJevWorker();
  }
}
