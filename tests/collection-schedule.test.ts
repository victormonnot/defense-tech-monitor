import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  collectScheduledSources,
  collectSources,
  type FetchResource,
} from "../src/lib/collector";
import {
  COLLECTION_LEASE_MS,
  collectionState,
  reserveCollection,
  updateCollectionSchedule,
} from "../src/lib/collection-state";
import { MonitorStore } from "../src/lib/store";

const start = Date.parse("2026-09-25T12:00:00.000Z");
const iso = (time: number) => new Date(time).toISOString();
const minute = 60000;

function storeFor(t: TestContext) {
  const store = new MonitorStore(":memory:", false);
  t.after(() => store.db.close());
  return store;
}

function addSource(store: MonitorStore, name = "alpha") {
  return store.addSource({
    name,
    siteUrl: `https://${name}.example.test/`,
    feedUrl: `https://${name}.example.test/feed`,
    language: "en",
  });
}

function response(title = "Synthetic drone trial", status = 200) {
  return {
    status,
    url: "https://alpha.example.test/feed",
    headers: { etag: "synthetic-etag" },
    body: `<rss version="2.0"><channel><title>Test</title><item><guid>one</guid><link>https://alpha.example.test/one</link><title>${title}</title><description>Synthetic article text.</description></item></channel></rss>`,
  };
}

function deferred() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

test("schedules default to paused, validate bounds, preserve idempotent saves and set explicit due times", (t) => {
  const store = storeFor(t);
  const initial = collectionState(store.db, start);
  assert.deepEqual(initial, {
    enabled: false,
    intervalMinutes: 60,
    nextRunAt: null,
    running: false,
    lastRun: null,
  });
  for (const value of [0, 14, 1441, 15.5, Infinity, NaN, "60", null])
    assert.throws(
      () => updateCollectionSchedule(store.db, true, value as number, start),
      /fréquence/,
    );
  assert.throws(
    () =>
      updateCollectionSchedule(
        store.db,
        "true" as unknown as boolean,
        60,
        start,
      ),
    /invalide/,
  );
  assert.deepEqual(collectionState(store.db, start), initial);
  updateCollectionSchedule(store.db, true, 60, start);
  assert.equal(collectionState(store.db, start).nextRunAt, iso(start));
  updateCollectionSchedule(store.db, true, 60, start + minute);
  assert.equal(collectionState(store.db, start).nextRunAt, iso(start));
  updateCollectionSchedule(store.db, true, 30, start + minute);
  assert.equal(
    collectionState(store.db, start).nextRunAt,
    iso(start + 31 * minute),
  );
  updateCollectionSchedule(store.db, false, 30, start + 2 * minute);
  assert.equal(collectionState(store.db, start).nextRunAt, null);
  updateCollectionSchedule(store.db, true, 1440, start + 3 * minute);
  assert.equal(
    collectionState(store.db, start).nextRunAt,
    iso(start + 3 * minute),
  );
});

test("automatic runs reserve atomically across database connections and share the manual and CLI lock", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-schedule-lock-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "monitor.sqlite");
  const first = new MonitorStore(path, false);
  const second = new MonitorStore(path, false);
  t.after(() => {
    first.db.close();
    second.db.close();
  });
  addSource(first);
  updateCollectionSchedule(first.db, true, 60, start);
  let time = start;
  const gate = deferred();
  let calls = 0;
  const fetcher: FetchResource = async () => {
    calls++;
    await gate.wait;
    return response();
  };
  const pending = collectScheduledSources(first, fetcher, 15, () => time);
  assert.equal(collectionState(second.db, time).running, true);
  assert.equal(collectionState(second.db, time).lastRun?.trigger, "scheduled");
  assert.equal(
    await collectScheduledSources(second, fetcher, 15, () => time),
    null,
  );
  await assert.rejects(
    collectSources(second, fetcher, 15, { now: () => time }),
    /déjà en cours/,
  );
  await assert.rejects(
    collectSources(second, fetcher, 15, { trigger: "cli", now: () => time }),
    /déjà en cours/,
  );
  time += 2 * minute;
  gate.release();
  const result = await pending;
  assert.equal(calls, 1);
  assert.equal(result?.added, 1);
  const after = collectionState(second.db, time);
  assert.equal(after.running, false);
  assert.equal(after.nextRunAt, iso(time + 60 * minute));
  assert.equal(after.lastRun?.status, "success");
  assert.equal(after.lastRun?.finishedAt, iso(time));
  assert.deepEqual(after.lastRun?.result, result);
  assert.equal(
    await collectScheduledSources(first, fetcher, 15, () => time + minute),
    null,
  );
  assert.equal(calls, 1);
});

test("an overdue schedule makes one run and schedules from completion instead of replaying missed runs", async (t) => {
  const store = storeFor(t);
  addSource(store);
  updateCollectionSchedule(store.db, true, 15, start);
  const now = start + 3 * 24 * 60 * minute;
  let calls = 0;
  const fetcher: FetchResource = async () => {
    calls++;
    return response();
  };
  await collectScheduledSources(store, fetcher, 15, () => now);
  assert.equal(
    collectionState(store.db, now).nextRunAt,
    iso(now + 15 * minute),
  );
  assert.equal(
    await collectScheduledSources(store, fetcher, 15, () => now),
    null,
  );
  assert.equal(calls, 1);
});

test("completion uses the current interval and respects a pause made while fetching", async (t) => {
  for (const pause of [false, true])
    await t.test(pause ? "pause" : "changed interval", async (t) => {
      const store = storeFor(t);
      addSource(store);
      updateCollectionSchedule(store.db, true, 60, start);
      let time = start;
      const gate = deferred();
      const pending = collectScheduledSources(
        store,
        async () => {
          await gate.wait;
          return response();
        },
        15,
        () => time,
      );
      time += minute;
      updateCollectionSchedule(store.db, !pause, 30, time);
      time += minute;
      gate.release();
      await pending;
      const after = collectionState(store.db, time);
      assert.equal(after.enabled, !pause);
      assert.equal(after.intervalMinutes, 30);
      assert.equal(after.nextRunAt, pause ? null : iso(time + 30 * minute));
      assert.equal(after.lastRun?.status, "success");
    });
});

test("manual and CLI runs record bounded outcomes and reset the enabled schedule", async (t) => {
  const store = storeFor(t);
  addSource(store);
  updateCollectionSchedule(store.db, true, 60, start);
  await collectSources(store, async () => response(), 15, { now: () => start });
  assert.equal(collectionState(store.db, start).lastRun?.trigger, "manual");
  await collectSources(store, async () => response("Unavailable", 503), 15, {
    trigger: "cli",
    now: () => start + 20 * minute,
  });
  const failed = collectionState(store.db, start + 20 * minute);
  assert.equal(failed.lastRun?.trigger, "cli");
  assert.equal(failed.lastRun?.status, "failed");
  assert.equal(failed.lastRun?.result?.failed, 1);
  assert.equal(failed.nextRunAt, iso(start + 80 * minute));
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM collection_run").get()
      ?.count,
    1,
  );
  const second = addSource(store, "beta");
  await collectSources(
    store,
    async (url) =>
      response("Synthetic report", url.includes("beta") ? 503 : 200),
    15,
    { now: () => start + 40 * minute },
  );
  assert.equal(
    collectionState(store.db, start + 40 * minute).lastRun?.status,
    "partial",
  );
  store.toggleSource(second, false);
  await collectSources(
    store,
    async () => assert.fail("Recent source must be skipped"),
    15,
    { now: () => start + 40 * minute },
  );
  assert.equal(
    collectionState(store.db, start + 40 * minute).lastRun?.status,
    "success",
  );
  assert.equal(
    collectionState(store.db, start + 40 * minute).lastRun?.result?.checked,
    0,
  );
});

test("expired runs display interrupted without GET mutations then recover with bounded retry delay", async (t) => {
  const store = storeFor(t);
  addSource(store);
  updateCollectionSchedule(store.db, true, 60, start);
  reserveCollection(store.db, "scheduled", start);
  const now = start + COLLECTION_LEASE_MS;
  assert.equal(collectionState(store.db, now).running, false);
  assert.equal(collectionState(store.db, now).lastRun?.status, "interrupted");
  assert.equal(
    store.db.prepare("SELECT status FROM collection_run").get()?.status,
    "running",
  );
  let calls = 0;
  const fetcher: FetchResource = async () => {
    calls++;
    return response();
  };
  assert.equal(
    await collectScheduledSources(store, fetcher, 15, () => now),
    null,
  );
  const recovered = collectionState(store.db, now);
  assert.equal(recovered.lastRun?.status, "interrupted");
  assert.equal(recovered.lastRun?.finishedAt, iso(now));
  assert.equal(recovered.nextRunAt, iso(now + 60 * minute));
  assert.equal(
    await collectScheduledSources(store, fetcher, 15, () => now + 59 * minute),
    null,
  );
  assert.equal(calls, 0);
  assert.equal(
    (await collectScheduledSources(store, fetcher, 15, () => now + 60 * minute))
      ?.added,
    1,
  );
});

test("an expired worker cannot write a late response or error over its successor", async (t) => {
  for (const reject of [false, true])
    await t.test(
      reject ? "late fetch failure" : "late successful response",
      async (t) => {
        const store = storeFor(t);
        addSource(store);
        let time = start;
        const gate = deferred();
        const old = collectSources(
          store,
          async () => {
            await gate.wait;
            if (reject) throw new Error("Old request failed");
            return response("Stale response");
          },
          1,
          { now: () => time },
        );
        time += COLLECTION_LEASE_MS + minute;
        await collectSources(
          store,
          async () => response("Successor response"),
          1,
          { now: () => time },
        );
        const before = store.snapshot();
        const latestRun = store.db
          .prepare("SELECT * FROM collection_run")
          .get();
        const rejected = assert.rejects(old, /perdu son verrou/);
        gate.release();
        await rejected;
        assert.deepEqual(store.snapshot(), before);
        assert.deepEqual(
          store.db.prepare("SELECT * FROM collection_run").get(),
          latestRun,
        );
        assert.equal(before.articles[0].title, "Successor response");
        assert.equal(before.articles[0].revision, 1);
      },
    );
});

test("scheduled configuration failures are recorded and deferred instead of retried on each tick", async (t) => {
  const store = storeFor(t);
  updateCollectionSchedule(store.db, true, 60, start);
  await assert.rejects(
    collectScheduledSources(
      store,
      async () => assert.fail("No fetch"),
      NaN,
      () => start,
    ),
    /DTM_COLLECTION_INTERVAL_MINUTES/,
  );
  const after = collectionState(store.db, start);
  assert.equal(after.running, false);
  assert.equal(after.lastRun?.status, "failed");
  assert.match(after.lastRun?.error ?? "", /DTM_COLLECTION_INTERVAL_MINUTES/);
  assert.equal(after.nextRunAt, iso(start + 60 * minute));
  assert.equal(
    await collectScheduledSources(
      store,
      async () => assert.fail("No fetch"),
      NaN,
      () => start + minute,
    ),
    null,
  );
});

test("unexpected collection failures persist the outcome and release the lease", async (t) => {
  const store = storeFor(t);
  store.sources = () => {
    throw new Error("Synthetic failure");
  };
  await assert.rejects(
    collectSources(store, async () => response(), 15, { now: () => start }),
    /Synthetic failure/,
  );
  const after = collectionState(store.db, start);
  assert.equal(after.lastRun?.status, "failed");
  assert.equal(after.lastRun?.error, "Synthetic failure");
  assert.equal(after.running, false);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM collection_lock").get()
      ?.count,
    0,
  );
});

test("source configuration changes discard in-flight responses without restoring old articles or cache", async (t) => {
  for (const change of ["feed", "language", "disabled"] as const)
    await t.test(change, async (t) => {
      const store = storeFor(t);
      const id = addSource(store);
      const gate = deferred();
      const pending = collectSources(
        store,
        async () => {
          await gate.wait;
          return response();
        },
        15,
        { now: () => start },
      );
      if (change === "disabled") store.toggleSource(id, false);
      else
        store.addSource({
          name: "alpha",
          siteUrl: "https://alpha.example.test/",
          feedUrl:
            change === "feed"
              ? "https://alpha.example.test/new-feed"
              : "https://alpha.example.test/feed",
          language: change === "language" ? "fr" : "en",
        });
      const sourceBefore = store.db
        .prepare("SELECT * FROM sources WHERE id=?")
        .get(id);
      gate.release();
      const result = await pending;
      assert.equal(result.added, 0);
      assert.equal(result.failed, 0);
      assert.equal(result.skipped, 1);
      assert.equal(store.snapshot().articles.length, 0);
      assert.deepEqual(
        store.db.prepare("SELECT * FROM sources WHERE id=?").get(id),
        sourceBefore,
      );
    });
});

test("late source errors cannot overwrite edited configuration and queued disabled sources are not fetched", async (t) => {
  const store = storeFor(t);
  const first = addSource(store);
  const second = addSource(store, "beta");
  const gate = deferred();
  let calls = 0;
  const pending = collectSources(
    store,
    async () => {
      calls++;
      await gate.wait;
      throw new Error("Old failure");
    },
    15,
    { now: () => start },
  );
  store.addSource({
    name: "alpha",
    siteUrl: "https://alpha.example.test/",
    feedUrl: "https://alpha.example.test/new-feed",
    language: "en",
  });
  store.toggleSource(second, false);
  gate.release();
  const result = await pending;
  assert.equal(calls, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 2);
  const current = store.sources().find((source) => source.id === first)!;
  assert.equal(current.lastError, null);
  assert.equal(current.status, "pending");
});
