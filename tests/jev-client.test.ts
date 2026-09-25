import assert from "node:assert/strict";
import test from "node:test";
import {
  buildJevInput,
  callJev,
  getJevConfig,
  JevRequestError,
  JEV_MODEL,
  parseJevResult,
} from "../src/lib/jev-client";
import {
  comparePersonalPriority,
  jevDecision,
  matchesProfile,
  evaluateSelection,
} from "../src/lib/selection";
import type { Article, Profile } from "../src/lib/types";
import { GENERAL_FEED, type CustomFeed } from "../src/lib/custom-feeds";

const profile: Profile = {
  keywords: ["robot", "navigation"],
  excludeKeywords: ["game"],
  minScore: 1,
};
const article = {
  title: "Synthetic robot publication",
  text: "Private collected test body",
  excerpt: "Public test excerpt",
  language: "en",
  contentBasis: "feed_text" as const,
};
const response = () => ({
  model: JEV_MODEL,
  answers: {
    relevance: {
      type: "score",
      score: 2.8,
      confidence: 0.85,
      probabilities: { 0: 0, 1: 0, 2: 0.2, 3: 0.8 },
      legend: { 0: "none", 1: "weak", 2: "relevant", 3: "detailed" },
    },
    kind: {
      type: "choice",
      choice: "technical",
      confidence: 0.9,
      probabilities: {
        technical: 0.9,
        field_report: 0.1,
        research: 0,
        business: 0,
        general: 0,
        unknown: 0,
      },
    },
  },
  usage: { input_tokens: 1300, output_tokens: 60 },
});

test("Jev is disabled without explicit local configuration and rejects malformed caps without leaking keys", () => {
  assert.deepEqual(getJevConfig({}), {
    apiKey: null,
    monthlyBudgetUsd: 0,
    error: null,
  });
  assert.equal(
    getJevConfig({
      TYPESAFE_API_KEY: "secret",
      DTM_JEV_MONTHLY_BUDGET_USD: "5",
    }).monthlyBudgetUsd,
    5,
  );
  for (const value of [
    "-1",
    "Infinity",
    "NaN",
    "1e2",
    "0x10",
    "1.234",
    "101",
  ]) {
    const config = getJevConfig({
      TYPESAFE_API_KEY: "secret",
      DTM_JEV_MONTHLY_BUDGET_USD: value,
    });
    assert.ok(config.error);
    assert.equal(config.monthlyBudgetUsd, 0);
    assert.ok(!config.error.includes("secret"));
  }
  assert.equal(
    getJevConfig({ TYPESAFE_API_KEY: "secret\nheader" }).apiKey,
    null,
  );
});

test("Jev sends only the chosen available content and never substitutes metadata for article text", () => {
  const full = buildJevInput(article, profile);
  assert.equal(full.request.state.article.content, article.text);
  assert.equal(full.request.model, JEV_MODEL);
  const excerpt = buildJevInput(article, {
    ...profile,
    matchScope: "title_excerpt",
  });
  assert.equal(excerpt.request.state.article.content, article.excerpt);
  const metadata = buildJevInput(
    { ...article, contentBasis: "metadata" },
    profile,
  );
  assert.equal(metadata.request.state.article.content, "");
  assert.equal(metadata.request.state.article.basis, "metadata");
  assert.deepEqual(full.request.state.reader, {
    interests: profile.keywords,
    exclusions: profile.excludeKeywords,
  });
  assert.match(full.request.questions.relevance.instructions, /untrusted/);
  assert.ok(!JSON.stringify(full.request).includes("sourceId"));
});

test("cache keys follow request content, profile semantics, language, scope and provenance, not the keyword-count threshold", () => {
  const key = buildJevInput(article, profile).cacheKey;
  assert.equal(
    buildJevInput(article, { ...profile, minScore: 5 }).cacheKey,
    key,
  );
  for (const other of [
    buildJevInput({ ...article, text: "Corrected collected text" }, profile),
    buildJevInput({ ...article, title: "Corrected title" }, profile),
    buildJevInput({ ...article, language: "uk" }, profile),
    buildJevInput({ ...article, contentBasis: "page_excerpt" }, profile),
    buildJevInput(article, { ...profile, keywords: ["industrialisation"] }),
    buildJevInput(article, { ...profile, excludeKeywords: [] }),
    buildJevInput(article, { ...profile, matchScope: "title_excerpt" }),
  ])
    assert.notEqual(other.cacheKey, key);
});

test("a custom feed uses its own brief and exclusions without leaking unrelated global interests", () => {
  const feed = {
    ...GENERAL_FEED,
    instructions: "Suivre les levées de fonds des startups de robotique.",
    exclusions: "Annonces sans lien avec la robotique.",
  };
  const unrelatedProfile = {
    ...profile,
    keywords: ["GLOBAL PRIVATE INTEREST"],
    excludeKeywords: ["GLOBAL PRIVATE EXCLUSION"],
    matchScope: "title_excerpt" as const,
  };
  const { request } = buildJevInput(article, unrelatedProfile, feed);
  assert.deepEqual(request.state.reader, {
    interests: [feed.instructions],
    exclusions: [feed.exclusions],
  });
  assert.equal(request.state.article.scope, "title_excerpt");
  assert.equal(request.state.article.content, article.excerpt);
  assert.ok(!JSON.stringify(request).includes("GLOBAL PRIVATE"));
  assert.deepEqual(
    buildJevInput(article, profile, { ...feed, exclusions: "" }).request.state
      .reader.exclusions,
    [],
  );
  assert.deepEqual(
    request.questions,
    buildJevInput(article, profile).request.questions,
  );
});

test("custom feed scores can be filtered and renamed without invalidating analysis, while edited briefs invalidate it", () => {
  const feed: CustomFeed = {
    ...GENERAL_FEED,
    id: "feed-1",
    isGeneral: false,
    archived: false,
    revision: 1,
    analysis: { ready: 0, pending: 1, failed: 0 },
  };
  const key = buildJevInput(article, profile, feed).cacheKey;
  const settingsOnly: CustomFeed = {
    ...feed,
    id: "feed-2",
    name: "A renamed feed",
    minScore: 0.5,
    minConfidence: 0.9,
    sort: "date",
    enabled: false,
    archived: true,
    revision: 2,
    analysis: { ready: 1, pending: 0, failed: 0 },
  };
  assert.equal(buildJevInput(article, profile, settingsOnly).cacheKey, key);
  assert.equal(
    buildJevInput(
      article,
      {
        ...profile,
        keywords: ["new unrelated keywords"],
        excludeKeywords: [],
        minScore: 20,
      },
      feed,
    ).cacheKey,
    key,
  );
  for (const changed of [
    buildJevInput(article, profile, {
      ...feed,
      instructions: "Suivre les startups.",
    }),
    buildJevInput(article, profile, {
      ...feed,
      exclusions: "Aucune annonce financière.",
    }),
    buildJevInput(article, { ...profile, matchScope: "title_excerpt" }, feed),
    buildJevInput({ ...article, title: "A revised title" }, profile, feed),
    buildJevInput({ ...article, text: "A revised body" }, profile, feed),
  ])
    assert.notEqual(changed.cacheKey, key);
});

test("briefs stay intact when article content is truncated, and metadata-only articles still send no body", () => {
  const feed = {
    ...GENERAL_FEED,
    instructions: "робот ".repeat(600),
    exclusions: "排除".repeat(900),
  };
  const { request } = buildJevInput(
    { ...article, text: "🤖дрони".repeat(20000) },
    profile,
    feed,
  );
  assert.equal(request.state.article.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 28000);
  assert.deepEqual(request.state.reader, {
    interests: [feed.instructions],
    exclusions: [feed.exclusions],
  });
  assert.ok(!/[\uD800-\uDBFF]$/.test(request.state.article.content));
  const metadata = buildJevInput(
    { ...article, contentBasis: "metadata" },
    profile,
    feed,
  );
  assert.equal(metadata.request.state.article.content, "");
  assert.equal(metadata.request.state.article.basis, "metadata");
});

test("oversized multilingual content is bounded with truthful truncation, without cutting a surrogate pair", () => {
  const original = { ...article, text: "🤖дрони".repeat(20000) };
  const { request } = buildJevInput(original, profile);
  assert.equal(request.state.article.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 28000);
  assert.ok(original.text.startsWith(request.state.article.content));
  assert.ok(!/[\uD800-\uDBFF]$/.test(request.state.article.content));
  assert.deepEqual(request.state.reader.interests, profile.keywords);
});

test("Jev validates typed results, bounded usage and consistency before accepting a classification", () => {
  assert.deepEqual(parseJevResult(response()), {
    score: 2.8,
    confidence: 0.85,
    kind: "technical",
    kindConfidence: 0.9,
    model: JEV_MODEL,
    inputTokens: 1300,
  });
  const invalid: unknown[] = [
    null,
    [],
    {},
    { ...response(), model: "jev-latest" },
  ];
  for (const change of [
    (r: ReturnType<typeof response>) => {
      r.answers.relevance.score = 4;
    },
    (r: ReturnType<typeof response>) => {
      r.answers.relevance.score = NaN;
    },
    (r: ReturnType<typeof response>) => {
      r.answers.relevance.confidence = 1.1;
    },
    (r: ReturnType<typeof response>) => {
      r.answers.relevance.score = 1;
    },
    (r: ReturnType<typeof response>) => {
      r.answers.kind.choice = "attack";
    },
    (r: ReturnType<typeof response>) => {
      r.answers.kind.choice = "general";
    },
    (r: ReturnType<typeof response>) => {
      r.usage.input_tokens = 64001;
    },
    (r: ReturnType<typeof response>) => {
      r.usage.input_tokens = 1.5;
    },
    (r: ReturnType<typeof response>) => {
      r.answers.relevance.probabilities[3] = 0.3;
    },
  ]) {
    const value = response();
    change(value);
    invalid.push(value);
  }
  for (const value of invalid)
    assert.throws(() => parseJevResult(value), JevRequestError);
});

test("the HTTP adapter pins the official endpoint and model, disallows redirects and makes exactly one request", async () => {
  let calls = 0;
  const result = await callJev(
    buildJevInput(article, profile).request,
    "synthetic-key",
    async (url, options) => {
      calls++;
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(options?.redirect, "error");
      assert.equal(options?.method, "POST");
      assert.equal(
        new Headers(options?.headers).get("Authorization"),
        "Bearer synthetic-key",
      );
      assert.ok(options?.signal);
      assert.equal(JSON.parse(String(options?.body)).model, JEV_MODEL);
      return Response.json(response());
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.inputTokens, 1300);
});

test("HTTP failures and malformed or oversized responses never echo provider content, request text or credentials", async () => {
  const sentinel = "PRIVATE SENTINEL synthetic-key";
  for (const factory of [
    () => new Response(sentinel, { status: 401 }),
    () => new Response(sentinel, { status: 429 }),
    () => new Response(sentinel, { status: 500 }),
    () => new Response(sentinel),
    () => new Response("x".repeat(64001)),
    () => Response.json({ message: sentinel }),
    () => {
      throw new Error(sentinel);
    },
  ]) {
    let calls = 0;
    await assert.rejects(
      callJev(
        buildJevInput(article, profile).request,
        "synthetic-key",
        async () => {
          calls++;
          return factory();
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof JevRequestError);
        assert.equal(error.beforeRequest, false);
        assert.ok(!error.message.includes(sentinel));
        assert.ok(!error.message.includes("synthetic-key"));
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("invalid credentials and oversized profiles are rejected before any outbound request", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json(response());
  };
  const request = buildJevInput(article, profile).request;
  for (const key of ["", "bad\nkey"])
    await assert.rejects(
      callJev(request, key, fetcher),
      (error: unknown) =>
        error instanceof JevRequestError && error.beforeRequest,
    );
  const huge = buildJevInput(article, {
    ...profile,
    keywords: Array(100).fill("🤖".repeat(50)),
    excludeKeywords: Array(100).fill("🤖".repeat(50)),
  });
  assert.equal(huge.request.state.reader.interests.length, 100);
  await assert.rejects(
    callJev(huge.request, "synthetic-key", fetcher),
    (error: unknown) => error instanceof JevRequestError && error.beforeRequest,
  );
  assert.equal(calls, 0);
});

function selectedArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: "test",
    sourceId: "source",
    sourceName: "Test",
    title: "Test",
    url: "https://example.test",
    publishedAt: "2026-09-25",
    collectedAt: "2026-09-25T00:00:00Z",
    updatedAt: null,
    revision: 1,
    changeKind: null,
    language: "en",
    format: "article",
    themes: [],
    excerpt: null,
    contentBasis: "metadata",
    score: 0,
    reasons: [],
    isRead: false,
    saved: false,
    feedback: null,
    keepSeparate: false,
    folderIds: [],
    jev: {
      ...parseJevResult(response()),
      evaluatedAt: "2026-09-25T00:00:00Z",
      applied: true,
      scope: "all_text",
      truncated: false,
    },
    ...overrides,
  };
}

test("Jev decisions apply only in personal mode with enough confidence; explicit feedback always wins", () => {
  const a = selectedArticle();
  assert.equal(jevDecision(a), true);
  assert.equal(matchesProfile(a, profile), true);
  assert.equal(
    matchesProfile({ ...a, jev: { ...a.jev!, applied: false } }, profile),
    false,
  );
  assert.equal(
    matchesProfile({ ...a, jev: { ...a.jev!, confidence: 0.59 } }, profile),
    false,
  );
  assert.equal(
    matchesProfile(
      { ...a, score: 3, jev: { ...a.jev!, confidence: 0.59 } },
      profile,
    ),
    true,
  );
  assert.equal(matchesProfile({ ...a, feedback: "off_topic" }, profile), false);
  assert.equal(matchesProfile({ ...a, feedback: "seen" }, profile), false);
  assert.equal(
    matchesProfile(
      { ...a, feedback: "relevant", jev: { ...a.jev!, score: 0 } },
      profile,
    ),
    true,
  );
  assert.equal(
    matchesProfile({ ...a, score: 3, jev: { ...a.jev!, score: 0 } }, profile),
    false,
  );
  assert.equal(
    evaluateSelection([{ ...a, feedback: "relevant" }], profile).missedRelevant,
    1,
  );
});

test("personal ranking prioritizes explicit relevance then Jev interest, with stable date fallback", () => {
  const high = selectedArticle({ id: "high" });
  const low = selectedArticle({ id: "low", jev: { ...high.jev!, score: 2.2 } });
  const manual = selectedArticle({
    id: "manual",
    feedback: "relevant",
    jev: { ...high.jev!, score: 0 },
  });
  const fallback = selectedArticle({
    id: "fallback",
    jev: undefined,
    score: 1,
  });
  assert.deepEqual(
    [fallback, low, high, manual]
      .sort(comparePersonalPriority)
      .map((a) => a.id),
    ["manual", "high", "low", "fallback"],
  );
  assert.equal(
    jevDecision({ ...high, jev: { ...high.jev!, confidence: Infinity } }),
    null,
  );
});
