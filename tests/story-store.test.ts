import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorStore } from "../src/lib/store";
import type { FeedEntry } from "../src/lib/feed";

const collectedAt = "2026-01-02T12:00:00.000Z";
function fixture(site: string): FeedEntry {
  return {
    guid: "synthetic-launch",
    url: `https://${site}.example.test/launch`,
    title: "Aster Robotics unveils Raven autonomous navigation module",
    publishedAt: "2026-01-02T10:00:00.000Z",
    text: "",
    excerpt: null,
    language: "en",
    format: "article",
    contentHash: "synthetic-launch-v1",
  };
}

test("grouping preserves articles and personal state; corrections survive updates and restarts", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-stories-"));
  const path = join(directory, "monitor.sqlite");
  const store = new MonitorStore(path, false);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sources = ["alpha", "beta"].map((name) =>
    store.addSource({
      name,
      siteUrl: `https://${name}.example.test/`,
      feedUrl: `https://${name}.example.test/feed`,
      language: "en",
    }),
  );
  store.upsertEntries(sources[0], [fixture("alpha")], collectedAt);
  store.upsertEntries(sources[1], [fixture("beta")], collectedAt);
  const before = store.snapshot();
  assert.equal(before.articles.length, 2);
  assert.equal(before.stories.groups.length, 1);
  const first = before.articles.find(
    (article) => article.sourceId === sources[0],
  )!;
  const second = before.articles.find(
    (article) => article.sourceId === sources[1],
  )!;
  store.setArticleState(first.id, "saved", true);
  store.setArticleState(first.id, "is_read", true);
  store.setArticleState(first.id, "feedback", "relevant");
  store.setArticleState(first.id, "keep_separate", true);
  const separated = store.snapshot();
  assert.equal(separated.stories.groups.length, 0);
  assert.deepEqual(
    separated.articles.find((article) => article.id === second.id),
    second,
  );
  const changed = { ...fixture("alpha"), contentHash: "synthetic-launch-v2" };
  assert.deepEqual(store.upsertEntries(sources[0], [changed], collectedAt), {
    added: 0,
    updated: 1,
  });
  assert.deepEqual(store.snapshot().articles, separated.articles);
  store.db.close();
  const reopened = new MonitorStore(path, false);
  try {
    assert.deepEqual(reopened.snapshot(), separated);
    reopened.setArticleState(first.id, "keep_separate", false);
    assert.equal(reopened.snapshot().stories.groups.length, 1);
    const restored = reopened
      .snapshot()
      .articles.find((article) => article.id === first.id)!;
    assert.equal(restored.saved, true);
    assert.equal(restored.isRead, true);
    assert.equal(restored.feedback, "relevant");
    assert.equal(restored.collectedAt, collectedAt);
  } finally {
    reopened.db.close();
  }
});

test("different collected text beyond the displayed excerpt stays separate without exposing bodies", () => {
  const store = new MonitorStore(":memory:", false);
  try {
    const excerpt =
      "Synthetic shared introduction about the Raven navigation module. "
        .repeat(10)
        .slice(0, 480);
    for (const [index, name] of ["alpha", "beta"].entries()) {
      const source = store.addSource({
        name,
        siteUrl: `https://${name}.example.test/`,
        feedUrl: `https://${name}.example.test/feed`,
        language: "en",
      });
      store.upsertEntries(
        source,
        [
          {
            ...fixture(name),
            excerpt,
            text: `${excerpt} The measured endurance was ${index ? "six" : "two"} hours.`,
          },
        ],
        collectedAt,
      );
    }
    const snapshot = store.snapshot();
    assert.equal(snapshot.stories.groups.length, 0);
    assert.equal(snapshot.stories.related.length, 1);
    assert.equal(snapshot.articles.length, 2);
    assert.ok(
      snapshot.articles.every(
        (article) => !("comparisonText" in article) && !("text" in article),
      ),
    );
    assert.ok(!JSON.stringify(snapshot).includes("measured endurance"));
  } finally {
    store.db.close();
  }
});
