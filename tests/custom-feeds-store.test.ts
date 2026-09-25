import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  GENERAL_FEED,
  GENERAL_FEED_ID,
  type FeedInput,
} from "../src/lib/custom-feeds";
import { JEV_MODEL } from "../src/lib/jev-client";
import {
  claimJev,
  JEV_RESERVATION_NANOS,
  jevSnapshot,
  setJevMode,
  settleJev,
} from "../src/lib/jev-store";
import { processJevBatch } from "../src/lib/jev-worker";
import { matchesProfile } from "../src/lib/selection";
import { MonitorStore } from "../src/lib/store";

const now = Date.parse("2026-09-25T12:00:00Z");
const config = {
  apiKey: "synthetic-never-sent",
  monthlyBudgetUsd: 5,
  error: null,
};
const result = {
  score: 2.5,
  confidence: 0.9,
  kind: "technical" as const,
  kindConfidence: 0.8,
  model: JEV_MODEL,
  inputTokens: 1000,
};

function storeFor(t: TestContext) {
  const store = new MonitorStore(":memory:", false);
  t.after(() => store.db.close());
  return store;
}
function addArticles(store: MonitorStore, count = 1) {
  const id = store.addSource({
    name: "Synthetic",
    siteUrl: "https://example.test",
    feedUrl: "https://example.test/feed",
    language: "en",
  });
  store.upsertEntries(
    id,
    Array.from({ length: count }, (_, i) => ({
      guid: String(i),
      url: `https://example.test/${i}`,
      title: `Synthetic article ${i}`,
      text: `Synthetic available text ${i}`,
      excerpt: `Synthetic excerpt ${i}`,
      publishedAt: null,
      language: "en",
      format: "article" as const,
      contentHash: `fixture-${i}`,
    })),
    new Date(now).toISOString(),
  );
  return store.snapshot().articles;
}
function input(name: string, overrides: Partial<FeedInput> = {}): FeedInput {
  return {
    ...GENERAL_FEED,
    name,
    instructions: `Follow synthetic ${name} developments.`,
    exclusions: "",
    ...overrides,
  };
}
function edit(store: MonitorStore, id: string, changes: Partial<FeedInput>) {
  const feed = store.listCustomFeeds().find((feed) => feed.id === id)!;
  store.saveCustomFeed(id, { ...feed, ...changes }, feed.revision);
}
function state(store: MonitorStore) {
  return jevSnapshot(store, undefined, undefined, config, now);
}

test("only the general feed exists initially and optimistic revisions prevent lost edits", (t) => {
  const store = storeFor(t);
  const initial = store.listCustomFeeds();
  assert.equal(initial.length, 1);
  assert.equal(initial[0].id, GENERAL_FEED_ID);
  assert.equal(initial[0].isGeneral, true);
  assert.equal(initial[0].revision, 1);
  const id = store.saveCustomFeed(null, input("Drones"));
  const first = store.listCustomFeeds().find((feed) => feed.id === id)!;
  store.saveCustomFeed(
    id,
    { ...first, instructions: "Updated synthetic interest" },
    first.revision,
  );
  const after = store.snapshot();
  assert.throws(
    () =>
      store.saveCustomFeed(
        id,
        { ...first, name: "Lost update" },
        first.revision,
      ),
    /modifié ailleurs/,
  );
  assert.deepEqual(store.snapshot(), after);
  assert.throws(() => store.saveCustomFeed(id, first), /Version/);
  assert.throws(() => store.saveCustomFeed("missing", first, 1), /inconnu/);
  assert.throws(
    () => store.saveCustomFeed(null, { ...first, instructions: "" }),
    /consigne/,
  );
  assert.throws(
    () => edit(store, GENERAL_FEED_ID, { name: "Renamed" }),
    /renommé/,
  );
  assert.throws(
    () => store.setCustomFeedArchived(GENERAL_FEED_ID, true),
    /archivé/,
  );
  const stale = store.listCustomFeeds().find((feed) => feed.id === id)!;
  store.setCustomFeedArchived(id, true);
  assert.throws(
    () => store.saveCustomFeed(id, stale, stale.revision),
    /modifié ailleurs/,
  );
  assert.equal(
    store.listCustomFeeds().find((feed) => feed.id === id)?.revision,
    stale.revision + 1,
  );
});

test("one publication receives independent relevance judgments for each feed with one global ledger", async (t) => {
  const store = storeFor(t);
  addArticles(store);
  const drones = store.saveCustomFeed(null, input("Drones"));
  const startups = store.saveCustomFeed(null, input("Startups"));
  setJevMode(store, "compare", config);
  let calls = 0;
  await processJevBatch(store, {
    config: () => config,
    now: () => now,
    call: async (request) => {
      calls++;
      const instructions = request.state.reader.interests[0];
      return {
        ...result,
        score: instructions.includes("Drones")
          ? 0.4
          : instructions.includes("Startups")
            ? 2.8
            : 2,
      };
    },
  });
  const snapshot = store.snapshot();
  const article = snapshot.articles[0];
  assert.equal(calls, 3);
  assert.equal(article.jev?.score, 2);
  assert.equal(article.jev?.applied, false);
  assert.equal(article.feedAnalyses?.[drones].score, 0.4);
  assert.equal(article.feedAnalyses?.[startups].score, 2.8);
  assert.equal(article.feedAnalyses?.[drones].applied, true);
  assert.equal(snapshot.jev?.ready, 3);
  assert.equal(
    snapshot.customFeeds?.every((feed) => feed.analysis.ready === 1),
    true,
  );
  assert.equal(state(store).state.inputTokens, 3000);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM jev_attempts").get()?.count,
    3,
  );
});

test("renaming, thresholds and sort reuse cache, while instructions and exclusions invalidate only their feed", async (t) => {
  const store = storeFor(t);
  addArticles(store);
  const id = store.saveCustomFeed(null, input("Drones"));
  setJevMode(store, "personal", config);
  await processJevBatch(store, {
    config: () => config,
    now: () => now,
    call: async () => result,
  });
  edit(store, id, {
    name: "Renamed",
    minScore: 0,
    minConfidence: 0,
    sort: "date",
  });
  let snapshot = store.snapshot();
  assert.equal(
    snapshot.customFeeds?.find((feed) => feed.id === id)?.analysis.ready,
    1,
  );
  assert.equal(snapshot.articles[0].feedAnalyses?.[id].minScore, 0);
  assert.equal(snapshot.articles[0].feedAnalyses?.[id].minConfidence, 0);
  assert.equal(
    await processJevBatch(store, {
      config: () => config,
      now: () => now,
      call: async () => assert.fail("Settings must not reanalyze"),
    }),
    0,
  );
  edit(store, id, { instructions: "Different synthetic instructions" });
  snapshot = store.snapshot();
  assert.equal(snapshot.articles[0].feedAnalyses?.[id], undefined);
  assert.ok(snapshot.articles[0].jev);
  assert.equal(
    snapshot.customFeeds?.find((feed) => feed.id === id)?.analysis.pending,
    1,
  );
  await processJevBatch(store, {
    config: () => config,
    now: () => now,
    call: async () => result,
  });
  edit(store, id, { exclusions: "Exclude synthetic financing announcements" });
  assert.equal(store.snapshot().articles[0].feedAnalyses?.[id], undefined);
  assert.ok(store.snapshot().articles[0].jev);
});

test("general zero thresholds apply immediately and per-feed pauses preserve cached decisions", async (t) => {
  const store = storeFor(t);
  addArticles(store);
  store.setProfile({
    keywords: ["unmatched"],
    excludeKeywords: [],
    minScore: 99,
  });
  const id = store.saveCustomFeed(null, input("Custom"));
  setJevMode(store, "personal", config);
  await processJevBatch(store, {
    config: () => config,
    now: () => now,
    call: async () => ({ ...result, score: 0, confidence: 0 }),
  });
  edit(store, GENERAL_FEED_ID, {
    minScore: 0,
    minConfidence: 0,
    enabled: false,
  });
  edit(store, id, { enabled: false });
  let snapshot = store.snapshot();
  assert.equal(snapshot.articles[0].jev?.applied, true);
  assert.equal(matchesProfile(snapshot.articles[0], snapshot.profile), true);
  assert.equal(snapshot.jev?.ready, 0);
  assert.equal(
    snapshot.customFeeds?.every((feed) => feed.analysis.ready === 1),
    true,
  );
  assert.equal(
    await processJevBatch(store, {
      config: () => config,
      now: () => now,
      call: async () => assert.fail("Paused feeds must not fetch"),
    }),
    0,
  );
  setJevMode(store, "off", config);
  snapshot = store.snapshot();
  assert.equal(snapshot.articles[0].jev?.applied, false);
  assert.equal(snapshot.articles[0].feedAnalyses?.[id].applied, true);
  store.setCustomFeedArchived(id, true);
  assert.ok(store.snapshot().articles[0].feedAnalyses?.[id]);
});

test("per-feed feedback is isolated from other feeds, saved state and novelty", (t) => {
  const store = storeFor(t);
  const [article] = addArticles(store);
  const first = store.saveCustomFeed(null, input("Drones"));
  const second = store.saveCustomFeed(null, input("Startups"));
  store.setArticleState(article.id, "saved", true);
  const before = store.snapshot();
  store.setFeedFeedback(article.id, first, "off_topic");
  store.setFeedFeedback(article.id, second, "relevant");
  let snapshot = store.snapshot();
  assert.deepEqual(snapshot.articles[0].feedFeedback, {
    [first]: "off_topic",
    [second]: "relevant",
  });
  assert.deepEqual(
    { ...snapshot.articles[0], feedFeedback: undefined },
    { ...before.articles[0], feedFeedback: undefined },
  );
  assert.deepEqual(snapshot.activity, before.activity);
  store.setFeedFeedback(article.id, GENERAL_FEED_ID, "seen");
  snapshot = store.snapshot();
  assert.equal(snapshot.articles[0].feedback, "seen");
  assert.equal(snapshot.articles[0].feedFeedback?.[second], "relevant");
  store.setFeedFeedback(article.id, first, null);
  assert.deepEqual(store.snapshot().articles[0].feedFeedback, {
    [second]: "relevant",
  });
  store.setFeedFeedback(article.id, second, null);
  assert.equal(store.snapshot().articles[0].feedFeedback, undefined);
  const unchanged = store.snapshot();
  assert.throws(
    () => store.setFeedFeedback("missing", first, "relevant"),
    /Publication inconnue/,
  );
  assert.throws(
    () => store.setFeedFeedback(article.id, "missing", "relevant"),
    /Fil inconnu/,
  );
  assert.throws(
    () => store.setFeedFeedback(article.id, first, "invalid" as "seen"),
    /Retour invalide/,
  );
  assert.deepEqual(store.snapshot(), unchanged);
});

test("claims alternate feeds within each article and all feeds share the same hard spending cap", (t) => {
  const store = storeFor(t);
  addArticles(store, 2);
  store.saveCustomFeed(null, input("Drones"));
  store.saveCustomFeed(null, input("Startups"));
  setJevMode(store, "compare", config);
  const feeds = store.listCustomFeeds().map((feed) => feed.id);
  const titles: string[] = [];
  const claimed: string[] = [];
  const capped = {
    ...config,
    monthlyBudgetUsd: (3 * JEV_RESERVATION_NANOS) / 1e9,
  };
  for (let index = 0; index < 3; index++) {
    const claim = claimJev(store, capped, now)!;
    assert.ok(claim);
    claimed.push(claim.feedId);
    titles.push(claim.request.state.article.title);
    settleJev(store, claim, { ...result, inputTokens: 64000 }, now);
  }
  assert.deepEqual(claimed, feeds);
  assert.equal(new Set(titles).size, 1);
  assert.equal(claimJev(store, capped, now), null);
  const snapshot = jevSnapshot(store, undefined, undefined, capped, now);
  assert.equal(snapshot.state.budgetBlocked, true);
  assert.equal(snapshot.state.ready, 3);
  assert.equal(snapshot.state.pending, 3);
  assert.equal(snapshot.state.spentUsd, capped.monthlyBudgetUsd);
});

test("a result received after its feed was edited is cached but never applied to the changed instructions", async (t) => {
  const store = storeFor(t);
  addArticles(store);
  edit(store, GENERAL_FEED_ID, { enabled: false });
  const id = store.saveCustomFeed(null, input("Drones"));
  setJevMode(store, "compare", config);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const batch = processJevBatch(store, {
    config: () => config,
    now: () => now,
    call: async () => {
      await waiting;
      return result;
    },
  });
  edit(store, id, {
    instructions: "Changed while request was pending",
    enabled: false,
  });
  release();
  await batch;
  const snapshot = store.snapshot();
  assert.equal(snapshot.articles[0].feedAnalyses?.[id], undefined);
  assert.equal(
    snapshot.customFeeds?.find((feed) => feed.id === id)?.analysis.pending,
    1,
  );
  assert.equal(
    store.db
      .prepare("SELECT COUNT(*) AS count FROM jev_cache WHERE status='success'")
      .get()?.count,
    1,
  );
  assert.equal(state(store).state.inputTokens, 1000);
});

test("paused and archived feeds keep feedback and cache across reopening without running new analyses", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-feeds-reopen-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "monitor.sqlite");
  const first = new MonitorStore(path, false);
  const [article] = addArticles(first);
  const id = first.saveCustomFeed(null, input("Drones"));
  setJevMode(first, "compare", config);
  await processJevBatch(first, {
    config: () => config,
    now: () => now,
    call: async () => result,
  });
  first.setFeedFeedback(article.id, id, "relevant");
  first.setCustomFeedArchived(id, true);
  edit(first, GENERAL_FEED_ID, { enabled: false });
  const before = first.snapshot();
  first.db.close();
  const reopened = new MonitorStore(path, false);
  try {
    assert.deepEqual(reopened.snapshot(), before);
    assert.equal(
      await processJevBatch(reopened, {
        config: () => config,
        now: () => now,
        call: async () =>
          assert.fail("Archived and paused feeds must not fetch"),
      }),
      0,
    );
  } finally {
    reopened.db.close();
  }
});
