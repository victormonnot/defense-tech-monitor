import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/monitor/route";
import { MonitorStore } from "../src/lib/store";

test("collection API persists validated schedules and records manual runs without bypassing origin checks", async (t) => {
  const store = new MonitorStore(":memory:", false);
  const globals = globalThis as typeof globalThis & {
    monitorStore?: MonitorStore;
  };
  const previous = globals.monitorStore;
  globals.monitorStore = store;
  t.after(() => {
    globals.monitorStore = previous;
    store.db.close();
  });
  const base = "http://127.0.0.1:3001";
  const get = () =>
    GET(
      new NextRequest(`${base}/api/monitor`, {
        headers: { host: "127.0.0.1:3001" },
      }),
    );
  async function post(body: unknown, origin = base) {
    return POST(
      new NextRequest(`${base}/api/monitor`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:3001",
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
  }

  const initialResponse = await get();
  assert.equal(initialResponse.headers.get("cache-control"), "no-store");
  const initial = (await initialResponse.json()).snapshot;
  assert.equal(initial.collection.enabled, false);
  assert.equal(initial.collection.intervalMinutes, 60);
  assert.equal(initial.collection.nextRunAt, null);
  const action = {
    action: "updateCollectionSchedule",
    enabled: true,
    intervalMinutes: 30,
  };
  assert.equal((await post(action, "https://other.example")).status, 403);
  assert.equal(store.snapshot().collection.enabled, false);

  for (const invalid of [
    { ...action, enabled: "true" },
    { ...action, enabled: null },
    { ...action, intervalMinutes: "30" },
    { ...action, intervalMinutes: null },
    { ...action, intervalMinutes: 14 },
    { ...action, intervalMinutes: 1441 },
    { ...action, intervalMinutes: 30.5 },
    { action: "updateCollectionSchedule" },
  ]) {
    assert.equal((await post(invalid)).status, 400);
    assert.deepEqual(store.snapshot().collection, initial.collection);
  }

  const enabledResponse = await post(action);
  assert.equal(enabledResponse.status, 200);
  const enabled = (await enabledResponse.json()).snapshot.collection;
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.intervalMinutes, 30);
  assert.ok(Date.parse(enabled.nextRunAt) <= Date.now());
  assert.equal(enabled.lastRun, null);

  const pausedResponse = await post({ ...action, enabled: false });
  assert.equal(pausedResponse.status, 200);
  const paused = (await pausedResponse.json()).snapshot.collection;
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextRunAt, null);

  const collectResponse = await post({ action: "collect" });
  assert.equal(collectResponse.status, 200);
  const collected = (await collectResponse.json()).snapshot;
  assert.equal(collected.collection.enabled, false);
  assert.equal(collected.collection.nextRunAt, null);
  assert.equal(collected.collection.running, false);
  assert.equal(collected.collection.lastRun.trigger, "manual");
  assert.equal(collected.collection.lastRun.status, "success");
  assert.deepEqual(collected.collection.lastRun.result, {
    added: 0,
    updated: 0,
    failed: 0,
    skipped: 0,
    checked: 0,
  });
  assert.deepEqual(collected.articles, initial.articles);
  assert.deepEqual(collected.profile, initial.profile);
  assert.deepEqual((await (await get()).json()).snapshot, collected);
});
