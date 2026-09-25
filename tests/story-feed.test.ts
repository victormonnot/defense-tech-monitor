import assert from "node:assert/strict";
import test from "node:test";
import { buildFeedItems } from "../src/lib/story-feed";
import type { Article } from "../src/lib/types";

function article(id: string, overrides: Partial<Article> = {}): Article {
  return {
    id,
    sourceId: id,
    sourceName: `Fixture ${id}`,
    title: "Synthetic monitoring article",
    url: `https://example.test/${id}`,
    publishedAt: "2026-01-02",
    collectedAt: "2026-01-02T12:00:00.000Z",
    language: "en",
    format: "article",
    themes: [],
    excerpt: null,
    contentBasis: "metadata",
    score: 1,
    reasons: [],
    isRead: false,
    saved: false,
    feedback: null,
    keepSeparate: false,
    ...overrides,
  };
}

const group = { id: "story-a", articleIds: ["a", "b", "c"], reason: "Fixture" };

test("feed grouping preserves every visible publication and the first member's position", () => {
  const articles = [
    article("b"),
    article("unrelated"),
    article("a"),
    article("c"),
  ];
  const items = buildFeedItems(articles, [group]);
  assert.deepEqual(
    items.map((item) => item.id),
    ["story-a", "unrelated"],
  );
  assert.deepEqual(
    items[0].articles.map((item) => item.id),
    ["b", "a", "c"],
  );
  assert.deepEqual(
    items
      .flatMap((item) => item.articles)
      .map((item) => item.id)
      .sort(),
    articles.map((item) => item.id).sort(),
  );
});

test("source, search or saved filters never pull hidden group members back into the feed", () => {
  const saved = article("b", { saved: true });
  const items = buildFeedItems([saved], [group]);
  assert.deepEqual(items, [{ id: "b", articles: [saved], group: null }]);
  assert.deepEqual(buildFeedItems([], [group]), []);
});

test("a partial group contains only selected publications with independent personal state", () => {
  const articles = [
    article("c", { isRead: true }),
    article("a", { saved: true }),
  ];
  const items = buildFeedItems(articles, [group]);
  assert.deepEqual(items[0].articles, articles);
  assert.equal(items[0].articles.length, 2);
  assert.equal(items[0].articles[0].saved, false);
  assert.equal(items[0].articles[1].isRead, false);
  assert.deepEqual(
    buildFeedItems(articles, []).map((item) => item.id),
    ["c", "a"],
  );
});
