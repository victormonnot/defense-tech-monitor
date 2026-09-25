import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateSelection,
  matchesEvaluation,
  matchesProfile,
  matchesRules,
} from "../src/lib/selection";
import type { Article, Feedback, Profile } from "../src/lib/types";

const profile: Profile = { keywords: [], excludeKeywords: [], minScore: 2 };
const article = (
  score: number,
  feedback: Feedback | null = null,
): Pick<Article, "score" | "feedback"> => ({ score, feedback });

test("personal feedback corrects selection while keeping the rule result available", () => {
  assert.equal(matchesProfile(article(1), profile), false);
  assert.equal(matchesProfile(article(2), profile), true);
  assert.equal(matchesProfile(article(0, "relevant"), profile), true);
  assert.equal(matchesRules(article(0, "relevant"), profile), false);
  assert.equal(matchesProfile(article(4, "off_topic"), profile), false);
  assert.equal(matchesRules(article(4, "off_topic"), profile), true);
  assert.equal(matchesProfile(article(4, "seen"), profile), false);
});

test("manual corrections do not inflate the precision or recall of the rules", () => {
  const articles = [
    article(2, "relevant"),
    article(5, "relevant"),
    article(0, "relevant"),
    article(3, "off_topic"),
    article(0, "off_topic"),
    article(4, "seen"),
    article(1, "seen"),
    article(4),
    article(0),
  ];
  assert.deepEqual(evaluateSelection(articles, profile), {
    reviewed: 5,
    relevant: 3,
    offTopic: 2,
    seen: 2,
    matchedRelevant: 2,
    missedRelevant: 1,
    selectedOffTopic: 1,
    excludedOffTopic: 1,
    precision: 2 / 3,
    recall: 2 / 3,
  });
  assert.equal(
    articles.filter((item) => matchesProfile(item, profile)).length,
    4,
  );
});

test("seen and unreviewed articles do not supply relevance labels", () => {
  const baseline = evaluateSelection([article(2, "relevant")], profile);
  const result = evaluateSelection(
    [
      article(2, "relevant"),
      article(5, "seen"),
      article(1, "seen"),
      article(3),
    ],
    profile,
  );
  assert.deepEqual(result, { ...baseline, seen: 2 });
  assert.deepEqual(
    evaluateSelection([article(3, "seen"), article(3)], profile),
    {
      reviewed: 0,
      relevant: 0,
      offTopic: 0,
      seen: 1,
      matchedRelevant: 0,
      missedRelevant: 0,
      selectedOffTopic: 0,
      excludedOffTopic: 0,
      precision: null,
      recall: null,
    },
  );
});

test("undefined metrics remain distinct from a measured zero", () => {
  const empty = evaluateSelection([], profile);
  assert.equal(empty.precision, null);
  assert.equal(empty.recall, null);

  const missed = evaluateSelection([article(0, "relevant")], profile);
  assert.equal(missed.precision, null);
  assert.equal(missed.recall, 0);

  const falsePositive = evaluateSelection([article(3, "off_topic")], profile);
  assert.equal(falsePositive.precision, 0);
  assert.equal(falsePositive.recall, null);

  const excluded = evaluateSelection([article(0, "off_topic")], profile);
  assert.equal(excluded.precision, null);
  assert.equal(excluded.recall, null);
});

test("changing the threshold re-evaluates the same labels without mutating them", () => {
  const articles = [
    article(2, "relevant"),
    article(1, "relevant"),
    article(1, "off_topic"),
  ];
  const original = structuredClone(articles);
  const strict = evaluateSelection(articles, profile);
  const permissive = evaluateSelection(articles, { ...profile, minScore: 1 });
  assert.equal(strict.precision, 1);
  assert.equal(strict.recall, 0.5);
  assert.equal(strict.missedRelevant, 1);
  assert.equal(strict.selectedOffTopic, 0);
  assert.equal(permissive.precision, 2 / 3);
  assert.equal(permissive.recall, 1);
  assert.equal(permissive.missedRelevant, 0);
  assert.equal(permissive.selectedOffTopic, 1);
  assert.deepEqual(articles, original);
});

test("evaluation filters expose rule mistakes even after feedback corrects the feed", () => {
  const articles = [
    article(0),
    article(3),
    article(0, "relevant"),
    article(3, "relevant"),
    article(0, "off_topic"),
    article(3, "off_topic"),
    article(0, "seen"),
    article(3, "seen"),
  ];
  const filtered = (filter: Parameters<typeof matchesEvaluation>[2]) =>
    articles.filter((item) => matchesEvaluation(item, profile, filter));

  assert.deepEqual(filtered("unreviewed"), [articles[0], articles[1]]);
  assert.deepEqual(filtered("missed"), [articles[2]]);
  assert.deepEqual(filtered("off_topic"), [articles[5]]);
  assert.deepEqual(filtered("reviewed"), articles.slice(2));

  assert.equal(matchesProfile(articles[2], profile), true);
  assert.equal(matchesProfile(articles[5], profile), false);
  assert.equal(
    matchesEvaluation(articles[2], { ...profile, minScore: 0 }, "missed"),
    false,
  );
  assert.equal(
    matchesEvaluation(articles[5], { ...profile, minScore: 4 }, "off_topic"),
    false,
  );
});

test("clearing a correction returns both selection and review state to the rules", () => {
  for (const score of [0, 3]) {
    const corrected = article(score, "relevant");
    assert.equal(matchesProfile(corrected, profile), true);
    assert.equal(matchesEvaluation(corrected, profile, "reviewed"), true);
    corrected.feedback = null;
    assert.equal(matchesProfile(corrected, profile), score >= profile.minScore);
    assert.equal(matchesEvaluation(corrected, profile, "unreviewed"), true);
    assert.equal(evaluateSelection([corrected], profile).reviewed, 0);
  }
});
