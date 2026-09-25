import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/monitor/route";
import { GENERAL_FEED } from "../src/lib/custom-feeds";
import { MonitorStore } from "../src/lib/store";

test("feed API validates edits, reports stale revisions, isolates feedback and keeps GET read-only", async (t) => {
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
  const feed = {
    ...GENERAL_FEED,
    name: "Drones",
    instructions: "Synthetic drone developments",
  };
  const action = { action: "createCustomFeed", feed };
  assert.equal((await post(action, "https://outside.example")).status, 403);
  assert.equal(store.listCustomFeeds().length, 1);
  for (const invalid of [
    { ...feed, instructions: "" },
    { ...feed, minScore: -1 },
    { ...feed, minConfidence: 1.1 },
    { ...feed, sort: "unknown" },
    { ...feed, enabled: "true" },
  ])
    assert.equal((await post({ ...action, feed: invalid })).status, 400);
  const createdResponse = await post(action);
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  const id = created.feedId;
  assert.equal(typeof id, "string");
  assert.equal(
    created.snapshot.customFeeds.find(
      (value: { id: string }) => value.id === id,
    ).revision,
    1,
  );
  assert.equal(
    (
      await post({
        action: "updateCustomFeed",
        id,
        feed: { ...feed, name: "Renamed" },
        revision: 1,
      })
    ).status,
    200,
  );
  assert.equal(
    (await post({ action: "updateCustomFeed", id, feed, revision: 1 })).status,
    400,
  );
  assert.equal(
    (await post({ action: "updateCustomFeed", id, feed })).status,
    400,
  );
  assert.equal(
    store.listCustomFeeds().find((value) => value.id === id)?.name,
    "Renamed",
  );
  assert.equal(
    (
      await post({
        action: "setCustomFeedArchived",
        id: "general",
        value: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (await post({ action: "setCustomFeedArchived", id, value: true })).status,
    200,
  );
  assert.equal(
    (await post({ action: "setCustomFeedArchived", id, value: false })).status,
    200,
  );
  const sourceId = store.addSource({
    name: "Synthetic",
    siteUrl: "https://example.test",
    feedUrl: "https://example.test/feed",
    language: "en",
  });
  store.upsertEntries(
    sourceId,
    [
      {
        guid: "one",
        url: "https://example.test/one",
        title: "Synthetic article",
        text: "Synthetic excerpt",
        excerpt: "Synthetic excerpt",
        publishedAt: null,
        language: "en",
        format: "article",
        contentHash: "one",
      },
    ],
    "2026-09-25T12:00:00Z",
  );
  const articleId = store.snapshot().articles[0].id;
  assert.equal(
    (
      await post({
        action: "setFeedFeedback",
        id: articleId,
        feedId: id,
        value: "off_topic",
      })
    ).status,
    200,
  );
  assert.equal(store.snapshot().articles[0].feedback, null);
  assert.equal(store.snapshot().articles[0].feedFeedback?.[id], "off_topic");
  assert.equal(
    (
      await post({
        action: "setFeedFeedback",
        id: articleId,
        feedId: "missing",
        value: "relevant",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post({
        action: "setFeedFeedback",
        id: articleId,
        feedId: id,
        value: "unknown",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post({
        action: "setFeedFeedback",
        id: articleId,
        feedId: "general",
        value: "seen",
      })
    ).status,
    200,
  );
  assert.equal(store.snapshot().articles[0].feedback, "seen");
  const changes = store.db
    .prepare("SELECT total_changes() AS count")
    .get()?.count;
  const read = await GET();
  assert.equal(read.headers.get("cache-control"), "no-store");
  assert.equal(
    store.db.prepare("SELECT total_changes() AS count").get()?.count,
    changes,
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM jev_attempts").get()?.count,
    0,
  );
});
