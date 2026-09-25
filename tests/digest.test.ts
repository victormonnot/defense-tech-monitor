import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDigest,
  digestSnapshotKey,
  digestSourceIssueLabel,
  type Digest,
} from "../src/lib/digest";
import type { Article, Snapshot, Source } from "../src/lib/types";

const now = Date.parse("2026-09-25T12:00:00.000Z");
const hour = 60 * 60 * 1000;
const iso = (time: number) => new Date(time).toISOString();
const old = iso(now - 200 * hour);

function article(id: string, overrides: Partial<Article> = {}): Article {
  return {
    id,
    sourceId: "alpha",
    sourceName: "Synthetic source",
    title: `Synthetic publication ${id}`,
    url: `https://example.test/${id}`,
    publishedAt: "2025-01-01",
    collectedAt: iso(now - hour),
    updatedAt: null,
    revision: 1,
    changeKind: null,
    language: "en",
    format: "article",
    themes: [],
    excerpt: null,
    contentBasis: "metadata",
    score: 3,
    reasons: [],
    isRead: false,
    saved: false,
    feedback: null,
    keepSeparate: false,
    folderIds: [],
    ...overrides,
  };
}

function source(id: string, overrides: Partial<Source> = {}): Source {
  return {
    id,
    name: `Synthetic ${id}`,
    siteUrl: `https://${id}.example.test`,
    feedUrl: `https://${id}.example.test/feed`,
    collectionKind: "rss",
    collectionUrl: `https://${id}.example.test/feed`,
    language: "en",
    enabled: true,
    status: "ok",
    lastCheckedAt: iso(now - hour),
    lastSuccessAt: iso(now - hour),
    lastError: null,
    articleCount: 0,
    ...overrides,
  };
}

function snapshot(
  articles: Article[] = [],
  overrides: Partial<Snapshot> = {},
): Snapshot {
  return {
    articles,
    sources: [source("alpha")],
    folders: [],
    profile: { keywords: ["drone"], excludeKeywords: [], minScore: 2 },
    stories: { groups: [], related: [] },
    stats: {
      total: articles.length,
      selected: articles.length,
      unread: articles.length,
      saved: 0,
    },
    evaluation: {
      reviewed: 0,
      relevant: 0,
      offTopic: 0,
      seen: 0,
      matchedRelevant: 0,
      missedRelevant: 0,
      selectedOffTopic: 0,
      excludedOffTopic: 0,
      precision: null,
      recall: null,
    },
    collection: {
      enabled: false,
      intervalMinutes: 60,
      nextRunAt: null,
      running: false,
      lastRun: null,
    },
    activity: {
      startedAt: old,
      lastReviewedAt: null,
      newCount: 0,
      updatedCount: 0,
    },
    lastCollectionAt: iso(now - hour),
    ...overrides,
  };
}

function entries(digest: Digest) {
  return digest.sections.flatMap((section) =>
    section.items.flatMap((item) => item.entries),
  );
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test("a rolling daily window includes both exact boundaries and compares timezone offsets as instants", () => {
  const input = snapshot([
    article("end", { collectedAt: iso(now) }),
    article("start", { collectedAt: iso(now - 24 * hour) }),
    article("outside", { collectedAt: iso(now - 24 * hour - 1) }),
    article("future", { collectedAt: iso(now + 1) }),
    article("offset", { collectedAt: "2026-09-25T14:00:00+02:00" }),
  ]);
  const digest = buildDigest(input, { periodHours: 24, scope: "all", now });
  assert.equal(digest.from, iso(now - 24 * hour));
  assert.equal(digest.to, iso(now));
  assert.equal(digest.generatedAt, iso(now));
  assert.deepEqual(
    entries(digest).map(({ article }) => article.id),
    ["end", "offset", "start"],
  );
  assert.equal(entries(digest)[1].detectedAt, iso(now));
  assert.equal(digest.total, 3);
});

test("daily and weekly windows are absolute durations across daylight-saving transitions", () => {
  const anchor = Date.parse("2026-03-29T12:00:00Z");
  const input = snapshot([
    article("daily", { collectedAt: iso(anchor - 24 * hour) }),
    article("weekly", { collectedAt: iso(anchor - 168 * hour) }),
    article("older", { collectedAt: iso(anchor - 168 * hour - 1) }),
  ]);
  assert.equal(
    buildDigest(input, { periodHours: 24, scope: "all", now: anchor }).shown,
    1,
  );
  const weekly = buildDigest(input, {
    periodHours: 168,
    scope: "all",
    now: anchor,
  });
  assert.equal(weekly.from, "2026-03-22T12:00:00.000Z");
  assert.equal(weekly.shown, 2);
});

test("first import wins over a later update and ignores read, saved and acknowledged state", () => {
  const first = article("new", {
    collectedAt: iso(now - 2 * hour),
    updatedAt: iso(now - hour),
    revision: 2,
    isRead: true,
    saved: true,
    changeKind: null,
  });
  const updated = article("updated", {
    collectedAt: old,
    updatedAt: iso(now - hour),
    revision: 2,
    changeKind: null,
  });
  const digest = buildDigest(snapshot([first, updated]), {
    periodHours: 24,
    scope: "all",
    now,
  });
  const byId = new Map(
    entries(digest).map((entry) => [entry.article.id, entry]),
  );
  assert.equal(byId.get("new")?.kind, "new");
  assert.equal(byId.get("new")?.detectedAt, first.collectedAt);
  assert.equal(byId.get("updated")?.kind, "updated");
  assert.equal(byId.get("updated")?.detectedAt, updated.updatedAt);
  assert.equal(digest.newCount, 1);
  assert.equal(digest.updatedCount, 1);
  assert.equal(byId.get("new")?.article.publishedAt, "2025-01-01");
});

test("malformed collection dates and future revisions are excluded instead of leaking current future text", () => {
  const badDates = [
    "invalid",
    "2026-09-25",
    "2026-09-25T10:00:00",
    "2026-09-25T25:00:00Z",
    "2026-02-30T10:00:00Z",
    "2026-09-25T10:61:00Z",
    "2026-09-25T10:00:00+24:00",
  ];
  const input = snapshot([
    ...badDates.map((collectedAt, i) =>
      article(`bad-${i}`, { collectedAt, updatedAt: iso(now - hour) }),
    ),
    article("future-new-revision", { updatedAt: iso(now + 1) }),
    article("future-old-revision", {
      collectedAt: old,
      updatedAt: iso(now + hour),
    }),
  ]);
  assert.equal(
    buildDigest(input, { periodHours: 24, scope: "all", now }).shown,
    0,
  );
});

test("invalid and anterior updates never qualify older articles but do not hide valid first imports", () => {
  const input = snapshot([
    article("new-invalid", { updatedAt: "invalid" }),
    article("new-anterior", { updatedAt: old }),
    article("old-invalid", {
      collectedAt: old,
      updatedAt: "2026-02-30T10:00:00Z",
    }),
    article("old-anterior", {
      collectedAt: old,
      updatedAt: iso(now - 300 * hour),
    }),
    article("old-no-update", { collectedAt: old, changeKind: "new" }),
  ]);
  const digest = buildDigest(input, { periodHours: 24, scope: "all", now });
  assert.deepEqual(
    entries(digest).map(({ article }) => article.id),
    ["new-anterior", "new-invalid"],
  );
  assert.equal(digest.newCount, 2);
  assert.equal(digest.updatedCount, 0);
});

test("personal scope shares selection feedback rules and all scope keeps excluded and seen publications", () => {
  const input = snapshot(
    [
      article("scored", { score: 2 }),
      article("relevant", { score: -10, feedback: "relevant" }),
      article("off-topic", { score: 10, feedback: "off_topic" }),
      article("seen", { score: 10, feedback: "seen" }),
      article("low", { score: 1 }),
    ],
    { sources: [source("alpha", { enabled: false })] },
  );
  const personal = buildDigest(input, {
    periodHours: 24,
    scope: "personal",
    now,
  });
  assert.deepEqual(
    entries(personal).map(({ article }) => article.id),
    ["relevant", "scored"],
  );
  assert.equal(
    buildDigest(input, { periodHours: 24, scope: "all", now }).shown,
    5,
  );
});

test("grouping intersects only included publications and uses the most recent member's primary theme once", () => {
  const input = snapshot(
    [
      article("older", {
        collectedAt: iso(now - 2 * hour),
        themes: ["Drones", "Naval"],
      }),
      article("newer", { sourceId: "beta", themes: ["Robotique", "Drones"] }),
      article("hidden-scope", { feedback: "off_topic", themes: ["Naval"] }),
      article("hidden-date", { collectedAt: old, themes: ["Naval"] }),
      article("single", { themes: [] }),
    ],
    {
      stories: {
        groups: [
          {
            id: "story",
            articleIds: ["older", "newer", "hidden-scope", "hidden-date"],
            reason: "Synthetic group",
          },
        ],
        related: [],
      },
    },
  );
  const digest = buildDigest(input, {
    periodHours: 24,
    scope: "personal",
    now,
  });
  assert.deepEqual(
    digest.sections.map((section) => section.theme),
    ["Robotique", "Autres sujets"],
  );
  assert.equal(digest.sections[0].publicationCount, 2);
  assert.deepEqual(
    digest.sections[0].items[0].entries.map(({ article }) => article.id),
    ["newer", "older"],
  );
  assert.equal(digest.groupCount, 1);
  assert.equal(digest.shown, 3);
  assert.equal(
    new Set(entries(digest).map(({ article }) => article.id)).size,
    3,
  );
  assert.deepEqual(
    entries(digest).find(({ article }) => article.id === "older")?.article
      .themes,
    ["Drones", "Naval"],
  );
});

test("the 100-publication cap applies before grouping and counters describe only included publications", () => {
  const articles = Array.from({ length: 105 }, (_, i) => {
    const detectedAt = iso(now - i * 60000);
    return article(`article-${String(i).padStart(3, "0")}`, {
      collectedAt: i % 2 === 0 ? detectedAt : old,
      updatedAt: i % 2 === 0 ? null : detectedAt,
      sourceId: i < 100 ? (i % 2 === 0 ? "alpha" : "beta") : "omitted-source",
    });
  });
  const input = snapshot(articles.reverse(), {
    stories: {
      groups: [
        {
          id: "top-group",
          articleIds: ["article-000", "article-001", "article-104"],
          reason: "Synthetic",
        },
        {
          id: "boundary-group",
          articleIds: ["article-099", "article-100"],
          reason: "Synthetic",
        },
      ],
      related: [],
    },
  });
  const digest = buildDigest(input, { periodHours: 24, scope: "all", now });
  assert.equal(digest.total, 105);
  assert.equal(digest.shown, 100);
  assert.equal(digest.omitted, 5);
  assert.equal(digest.newCount, 50);
  assert.equal(digest.updatedCount, 50);
  assert.equal(digest.sourceCount, 2);
  assert.equal(digest.groupCount, 1);
  assert.equal(entries(digest).length, 100);
  assert.equal(
    new Set(entries(digest).map(({ article }) => article.id)).size,
    100,
  );
  assert.deepEqual(
    digest.sections[0].items[0].entries.map(({ article }) => article.id),
    ["article-000", "article-001"],
  );
  assert.equal(digest.sections[0].items.at(-1)?.id, "article-099");
  assert.ok(
    entries(digest).every(
      ({ article }) => article.sourceId !== "omitted-source",
    ),
  );
});

test("theme ordering uses publication counts then French labels and ties use article IDs", () => {
  const input = snapshot([
    article("z", { themes: ["Robotique"] }),
    article("b", { themes: ["Défense"] }),
    article("a", { themes: ["Défense"] }),
    article("n", { themes: ["Naval"] }),
    article("e", { themes: ["Électronique"] }),
  ]);
  const result = buildDigest(input, { periodHours: 24, scope: "all", now });
  assert.deepEqual(
    result.sections.map((section) => section.theme),
    ["Défense", "Électronique", "Naval", "Robotique"],
  );
  assert.deepEqual(
    result.sections[0].items.map((item) => item.id),
    ["a", "b"],
  );
  assert.deepEqual(
    buildDigest(
      { ...input, articles: [...input.articles].reverse() },
      { periodHours: 24, scope: "all", now },
    ),
    result,
  );
});

test("coverage issues remain global and include stale, malformed, missing and future collection times", () => {
  const sources = [
    source("error", { status: "error", lastError: "Synthetic failure" }),
    source("unsupported", { status: "unsupported" }),
    source("pending", { status: "pending" }),
    source("never", { lastCheckedAt: null }),
    source("stale", { lastCheckedAt: iso(now - 24 * hour - 1) }),
    source("invalid", { lastCheckedAt: "invalid" }),
    source("future", { lastCheckedAt: iso(now + 1) }),
    source("start", { lastCheckedAt: iso(now - 24 * hour) }),
    source("end", { lastCheckedAt: iso(now) }),
    source("empty", { status: "empty" }),
    source("disabled", {
      enabled: false,
      status: "error",
      lastCheckedAt: null,
    }),
  ];
  const digest = buildDigest(snapshot([], { sources }), {
    periodHours: 24,
    scope: "personal",
    now,
  });
  assert.deepEqual(
    digest.sourceIssues.map((source) => source.id),
    ["error", "future", "invalid", "never", "pending", "stale", "unsupported"],
  );
  const labels = new Map(
    digest.sourceIssues.map((source) => [
      source.id,
      digestSourceIssueLabel(source, digest.from),
    ]),
  );
  assert.equal(labels.get("error"), "Erreur de collecte");
  assert.equal(labels.get("unsupported"), "Connecteur indisponible");
  assert.equal(labels.get("never"), "Source non encore consultée");
  assert.equal(labels.get("pending"), "Source non encore consultée");
  for (const id of ["stale", "invalid", "future"])
    assert.equal(labels.get(id), "Aucune consultation dans la période");
});

test("digest creation and freshness keys leave the captured snapshot unchanged", () => {
  const input = freeze(
    snapshot([article("b"), article("a")], {
      stories: {
        groups: [{ id: "story", articleIds: ["b", "a"], reason: "Synthetic" }],
        related: [],
      },
    }),
  );
  const before = JSON.stringify(input);
  const first = buildDigest(input, { periodHours: 24, scope: "all", now });
  const key = digestSnapshotKey(input);
  assert.deepEqual(
    buildDigest(input, { periodHours: 24, scope: "all", now }),
    first,
  );
  assert.equal(digestSnapshotKey(input), key);
  assert.equal(JSON.stringify(input), before);
  assert.equal(
    digestSnapshotKey({
      ...input,
      articles: [...input.articles].reverse(),
      stories: {
        ...input.stories,
        groups: [{ ...input.stories.groups[0], articleIds: ["a", "b"] }],
      },
    }),
    key,
  );
});

test("freshness ignores unrelated personal actions and heartbeats but notices displayed content and coverage", () => {
  const input = snapshot([article("one")]);
  const key = digestSnapshotKey(input);
  const unrelated = structuredClone(input);
  unrelated.articles[0].isRead = true;
  unrelated.articles[0].saved = true;
  unrelated.articles[0].changeKind = "updated";
  unrelated.articles[0].folderIds = ["folder"];
  unrelated.activity.lastReviewedAt = iso(now);
  unrelated.collection = {
    enabled: true,
    intervalMinutes: 30,
    nextRunAt: iso(now + hour),
    running: true,
    lastRun: {
      id: "run",
      trigger: "scheduled",
      startedAt: iso(now),
      finishedAt: null,
      status: "running",
      result: null,
      error: null,
    },
  };
  assert.equal(digestSnapshotKey(unrelated), key);
  for (const change of [
    (value: Snapshot) => {
      value.articles[0].title = "Corrected title";
    },
    (value: Snapshot) => {
      value.articles[0].feedback = "off_topic";
    },
    (value: Snapshot) => {
      value.profile.minScore = 5;
    },
    (value: Snapshot) => {
      value.sources[0].lastCheckedAt = iso(now);
    },
    (value: Snapshot) => {
      value.sources[0].lastError = "Error";
    },
    (value: Snapshot) => {
      value.stories.groups.push({
        id: "story",
        articleIds: ["one", "two"],
        reason: "Synthetic",
      });
    },
  ]) {
    const changed = structuredClone(input);
    change(changed);
    assert.notEqual(digestSnapshotKey(changed), key);
  }
});

test("unsupported scopes, periods and invalid anchors are rejected", () => {
  const input = snapshot();
  for (const anchor of [NaN, Infinity, -Infinity, 9e15, -8.64e15])
    assert.throws(
      () => buildDigest(input, { periodHours: 24, scope: "all", now: anchor }),
      /invalide/,
    );
  assert.throws(
    () => buildDigest(input, { periodHours: 12 as 24, scope: "all", now }),
    /invalides/,
  );
  assert.throws(
    () =>
      buildDigest(input, { periodHours: 24, scope: "unknown" as "all", now }),
    /invalides/,
  );
});
