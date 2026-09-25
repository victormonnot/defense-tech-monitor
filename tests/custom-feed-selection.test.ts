import assert from "node:assert/strict";
import test from "node:test";
import type { Article } from "../src/lib/types";
import type { CustomFeed } from "../src/lib/custom-feeds";
import type { JevAnalysis } from "../src/lib/jev-types";
import {
  articleForFeed,
  matchesCustomFeed,
  matchesProfile,
  jevDecision,
  comparePersonalPriority,
  compareFeedDate,
} from "../src/lib/selection";

const analysis: JevAnalysis = {
  score: 1.9,
  confidence: 0.8,
  kind: "business",
  kindConfidence: 0.8,
  model: "jev-1.13.0",
  evaluatedAt: "2026-09-25T12:00:00Z",
  applied: true,
  scope: "all_text",
  truncated: false,
};
const drones: CustomFeed = {
  id: "drones",
  name: "Drones",
  instructions: "Drone technology",
  exclusions: "",
  minScore: 1.5,
  minConfidence: 0.6,
  sort: "relevance",
  enabled: true,
  isGeneral: false,
  archived: false,
  revision: 1,
  analysis: { ready: 1, pending: 0, failed: 0 },
};
const base: Article = {
  id: "article",
  sourceId: "s",
  sourceName: "Source",
  title: "A new drone startup",
  url: "https://example.test/article",
  publishedAt: "2026-09-24T12:00:00Z",
  collectedAt: "2026-09-25T12:00:00Z",
  updatedAt: null,
  revision: 1,
  changeKind: null,
  language: "en",
  format: "article",
  themes: [],
  excerpt: null,
  contentBasis: "metadata",
  score: 5,
  reasons: [],
  isRead: true,
  saved: true,
  feedback: "off_topic",
  keepSeparate: false,
  folderIds: ["folder"],
  jev: { ...analysis, score: 0.4 },
  feedAnalyses: { drones: analysis, startups: { ...analysis, score: 2.8 } },
};

test("the same article has independent scores, thresholds and feedback in each feed", () => {
  assert.equal(matchesCustomFeed(base, drones), true);
  assert.equal(
    matchesProfile(base, { keywords: [], excludeKeywords: [], minScore: 1 }),
    false,
  );
  assert.equal(matchesCustomFeed(base, { ...drones, minScore: 2 }), false);
  assert.equal(
    matchesCustomFeed(base, { ...drones, id: "startups", minScore: 2 }),
    true,
  );
  const corrected = { ...base, feedFeedback: { drones: "off_topic" as const } };
  assert.equal(matchesCustomFeed(corrected, drones), false);
  assert.equal(
    matchesCustomFeed(corrected, { ...drones, id: "startups" }),
    true,
  );
  assert.equal(base.feedback, "off_topic");
  const scoped = articleForFeed(base, drones);
  assert.equal(scoped.feedback, null);
  assert.equal(scoped.jev?.score, 1.9);
  assert.equal(base.jev?.score, 0.4);
  assert.equal(scoped.saved, base.saved);
  assert.equal(scoped.isRead, base.isRead);
  assert.deepEqual(scoped.folderIds, base.folderIds);
});

test("missing or uncertain custom-feed analyses never fall back to global keywords", () => {
  assert.equal(matchesCustomFeed(base, { ...drones, id: "unknown" }), false);
  assert.equal(
    matchesCustomFeed(base, { ...drones, minConfidence: 0.9 }),
    false,
  );
  assert.equal(
    matchesCustomFeed(
      { ...base, feedAnalyses: {}, feedFeedback: { drones: "relevant" } },
      drones,
    ),
    true,
  );
  assert.equal(
    matchesCustomFeed({ ...base, feedFeedback: { drones: "seen" } }, drones),
    false,
  );
  assert.equal(matchesCustomFeed(base, { ...drones, enabled: false }), true);
  assert.equal(
    jevDecision({
      jev: {
        ...analysis,
        score: 0,
        confidence: 0,
        minScore: 0,
        minConfidence: 0,
      },
    }),
    true,
  );
});

test("general thresholds apply to the personal feed and uncertain results keep its keyword fallback", () => {
  const profile = { keywords: [], excludeKeywords: [], minScore: 1 };
  const item = {
    ...base,
    feedback: null,
    score: 0,
    jev: { ...analysis, minScore: 1.5, minConfidence: 0.6 },
  };
  assert.equal(matchesProfile(item, profile), true);
  assert.equal(
    matchesProfile({ ...item, jev: { ...item.jev, minScore: 2 } }, profile),
    false,
  );
  assert.equal(
    matchesProfile(
      { ...item, score: 2, jev: { ...item.jev, minConfidence: 0.9 } },
      profile,
    ),
    true,
  );
});

test("feed ordering switches between publication date and its own Jev score", () => {
  const older = articleForFeed(base, drones);
  const newer = articleForFeed(
    {
      ...base,
      id: "newer",
      publishedAt: "2026-09-25T12:00:00Z",
      feedAnalyses: { drones: { ...analysis, score: 1.7 } },
    },
    drones,
  );
  assert.deepEqual(
    [newer, older].sort(comparePersonalPriority).map((a) => a.id),
    ["article", "newer"],
  );
  assert.deepEqual(
    [older, newer].sort(compareFeedDate).map((a) => a.id),
    ["newer", "article"],
  );
  const fallback = { ...newer, id: "fallback", jev: undefined };
  assert.deepEqual(
    [fallback, older].sort(comparePersonalPriority).map((a) => a.id),
    ["article", "fallback"],
  );
});
