import { collectSources } from "../src/lib/collector";
import { getStore } from "../src/lib/store";

async function main() {
  const store = getStore();
  try {
    const result = await collectSources(store, undefined, undefined, {
      trigger: "cli",
    });
    console.log(
      JSON.stringify(
        {
          ...result,
          sources: store
            .sources()
            .map(({ name, status, articleCount, lastError }) => ({
              name,
              status,
              articleCount,
              lastError,
            })),
        },
        null,
        2,
      ),
    );
    if (result.failed) process.exitCode = 1;
  } finally {
    store.db.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
