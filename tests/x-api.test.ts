import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/monitor/route";
import { MonitorStore } from "../src/lib/store";

test("X source setup is normalized, idempotent and secret-free without any network request", async (t) => {
  const store = new MonitorStore(":memory:", false);
  const globals = globalThis as typeof globalThis & {
    monitorStore?: MonitorStore;
  };
  const previous = globals.monitorStore;
  const originalFetch = globalThis.fetch;
  const key = process.env.X_BEARER_TOKEN;
  const cap = process.env.DTM_X_MONTHLY_BUDGET_USD;
  globals.monitorStore = store;
  process.env.X_BEARER_TOKEN = "synthetic-secret-for-test";
  process.env.DTM_X_MONTHLY_BUDGET_USD = "1";
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("No request during setup");
  };
  t.after(() => {
    globals.monitorStore = previous;
    globalThis.fetch = originalFetch;
    if (key === undefined) delete process.env.X_BEARER_TOKEN;
    else process.env.X_BEARER_TOKEN = key;
    if (cap === undefined) delete process.env.DTM_X_MONTHLY_BUDGET_USD;
    else process.env.DTM_X_MONTHLY_BUDGET_USD = cap;
    store.db.close();
  });
  const base = "http://127.0.0.1:3001";
  const action = {
    action: "addSource",
    name: "Example X account",
    siteUrl: "@Example_Account",
    language: "und",
  };
  const post = (body: unknown, origin = base) =>
    POST(
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
  assert.equal((await post(action, "https://other.example")).status, 403);
  assert.equal(store.sources().length, 0);
  const added = await post(action);
  assert.equal(added.status, 200);
  const body = await added.json();
  assert.equal(
    body.snapshot.sources[0].siteUrl,
    "https://x.com/example_account",
  );
  assert.equal(body.snapshot.sources[0].collectionKind, "x");
  assert.equal(body.snapshot.x.configured, true);
  assert.equal(body.snapshot.x.spentUsd, 0);
  assert.ok(!JSON.stringify(body).includes("synthetic-secret"));
  const id = body.snapshot.sources[0].id;
  store.toggleSource(id, false);
  assert.equal(
    (
      await post({
        ...action,
        siteUrl: "https://twitter.com/EXAMPLE_ACCOUNT?s=20",
        name: "Renamed account",
      })
    ).status,
    200,
  );
  assert.equal(store.sources().length, 1);
  assert.equal(store.sources()[0].id, id);
  assert.equal(store.sources()[0].enabled, false);
  assert.equal(store.sources()[0].name, "Renamed account");
  for (const invalid of [
    { ...action, siteUrl: "https://x.com/example_account/status/123" },
    { ...action, siteUrl: "https://x.com/search?q=drone" },
    { ...action, siteUrl: "@bad handle" },
  ])
    assert.equal((await post(invalid)).status, 400);
  const read = await GET(
    new NextRequest(`${base}/api/monitor`, {
      headers: { host: "127.0.0.1:3001" },
    }),
  );
  assert.equal(read.status, 200);
  // A pre-existing profile using an explicitly configured RSS feed retains
  // that route (and its identity) when edited after upgrading.
  store.db
    .prepare(
      "INSERT INTO sources (id,name,site_url,feed_url,language) VALUES (?,?,?,?,?)",
    )
    .run(
      "legacy-x-rss",
      "Old feed",
      "https://twitter.com/Legacy",
      "https://example.com/feed",
      "en",
    );
  assert.equal(
    (
      await post({
        ...action,
        name: "Renamed RSS",
        siteUrl: "https://twitter.com/Legacy",
        feedUrl: "https://example.com/feed",
      })
    ).status,
    200,
  );
  const legacy = store.sources().find((s) => s.id === "legacy-x-rss")!;
  assert.equal(legacy.name, "Renamed RSS");
  assert.equal(legacy.collectionKind, "rss");
  assert.equal(legacy.feedUrl, "https://example.com/feed");
  assert.equal(requests, 0);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM x_requests").get()!.n,
    0,
  );
});
