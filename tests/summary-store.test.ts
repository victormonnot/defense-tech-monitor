import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { GENERAL_FEED } from "../src/lib/custom-feeds";
import {
  SUMMARY_INPUT_NANODOLLARS_PER_TOKEN,
  SUMMARY_MAX_INPUT_TOKENS,
  SUMMARY_MAX_OUTPUT_TOKENS,
  SUMMARY_MODEL,
  SUMMARY_OUTPUT_NANODOLLARS_PER_TOKEN,
  SUMMARY_RESERVED_NANODOLLARS,
  SummaryRequestError,
} from "../src/lib/summary-client";
import { processArticleSummary } from "../src/lib/summary-service";
import {
  claimSummary,
  failSummary,
  settleSummary,
  SUMMARY_LEASE_MS,
  summarySnapshot,
} from "../src/lib/summary-store";
import type { SummaryResult } from "../src/lib/summary-types";
import { MonitorStore } from "../src/lib/store";

const now = Date.parse("2026-09-25T12:00:00Z");
const config = {
  apiKey: "synthetic-key-never-sent",
  monthlyBudgetUsd: 3,
  error: null,
};
const content =
  "The synthetic manufacturer described an autonomous maritime prototype using radar and navigation sensors. Its engineers reported a controlled demonstration and noted that the platform still needs further field tests. ".repeat(
    4,
  );
const result: SummaryResult = {
  outcome: "summary",
  text: "Le fabricant présente un prototype maritime autonome équipé de capteurs de navigation. Selon ses ingénieurs, des essais complémentaires restent nécessaires.",
  model: SUMMARY_MODEL,
  inputTokens: 1000,
  outputTokens: 100,
};
const reservedUsd = SUMMARY_RESERVED_NANODOLLARS / 1e9;
const actualUsd =
  (result.inputTokens * SUMMARY_INPUT_NANODOLLARS_PER_TOKEN +
    result.outputTokens * SUMMARY_OUTPUT_NANODOLLARS_PER_TOKEN) /
  1e9;

function storeFor(t: TestContext) {
  const store = new MonitorStore(":memory:", false);
  t.after(() => store.db.close());
  return store;
}
function addArticles(store: MonitorStore, count = 1) {
  const sourceId = store.addSource({
    name: "Synthetic source",
    siteUrl: "https://example.test",
    feedUrl: "https://example.test/feed",
    language: "en",
  });
  store.upsertEntries(
    sourceId,
    Array.from({ length: count }, (_, index) => ({
      guid: String(index),
      url: `https://example.test/${index}`,
      title: `Synthetic prototype ${index}`,
      text: content,
      excerpt: "Synthetic available excerpt",
      publishedAt: null,
      language: "en",
      format: "article" as const,
      contentHash: `summary-fixture-${index}`,
    })),
    new Date(now).toISOString(),
  );
  return store.snapshot().articles;
}
function state(store: MonitorStore, time = now) {
  return summarySnapshot(store, undefined, config, time);
}
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

test("snapshots expose eligibility without generating, leaking full text or writing to the database", (t) => {
  const store = storeFor(t);
  const [eligible, short, metadata] = addArticles(store, 3);
  store.db
    .prepare("UPDATE articles SET text='Too short' WHERE id=?")
    .run(short.id);
  store.db
    .prepare("UPDATE articles SET content_basis='metadata' WHERE id=?")
    .run(metadata.id);
  const before = store.db
    .prepare("SELECT total_changes() AS count")
    .get()?.count;
  const snapshot = state(store);
  assert.equal(snapshot.state.eligible, 1);
  assert.equal(snapshot.state.ready, 0);
  assert.equal(snapshot.summaries.get(eligible.id)?.status, "available");
  assert.equal(snapshot.summaries.get(eligible.id)?.canGenerate, true);
  assert.equal(snapshot.summaries.get(short.id)?.status, "insufficient");
  assert.equal(snapshot.summaries.get(metadata.id)?.status, "insufficient");
  assert.equal(snapshot.summaries.get(metadata.id)?.canGenerate, false);
  const missing = summarySnapshot(
    store,
    undefined,
    { apiKey: null, monthlyBudgetUsd: 0, error: null },
    now,
  );
  assert.equal(missing.state.configured, false);
  assert.equal(missing.summaries.get(eligible.id)?.canGenerate, false);
  assert.match(missing.summaries.get(eligible.id)?.reason ?? "", /clé OpenAI/);
  const exposed = JSON.stringify(store.snapshot());
  assert.equal(exposed.includes(content), false);
  assert.equal(exposed.includes(config.apiKey), false);
  assert.equal(
    store.db.prepare("SELECT total_changes() AS count").get()?.count,
    before,
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM summary_attempts").get()
      ?.count,
    0,
  );
});

test("generation settles reported input and output usage once and cached results remain available without configuration", async (t) => {
  const store = storeFor(t);
  const [article] = addArticles(store);
  let calls = 0;
  const summary = await processArticleSummary(store, article.id, {
    config: () => config,
    now: () => now,
    call: async () => {
      calls++;
      assert.equal(state(store).state.reservedUsd, reservedUsd);
      assert.equal(state(store).state.running, true);
      assert.equal(state(store).summaries.get(article.id)?.status, "pending");
      return result;
    },
  });
  assert.equal(summary.status, "ready");
  assert.equal(summary.text, result.text);
  assert.equal(summary.generatedAt, new Date(now).toISOString());
  assert.equal(summary.model, SUMMARY_MODEL);
  assert.equal(summary.canGenerate, false);
  assert.equal(state(store).state.spentUsd, actualUsd);
  assert.equal(state(store).state.reservedUsd, 0);
  assert.equal(state(store).state.ready, 1);
  const cached = await processArticleSummary(store, article.id, {
    config: () => ({ apiKey: null, monthlyBudgetUsd: 0, error: null }),
    now: () => now,
    call: async () => assert.fail("Cached requests must not fetch"),
  });
  assert.deepEqual(cached, summary);
  assert.equal(calls, 1);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM summary_attempts").get()
      ?.count,
    1,
  );
});

test("short and metadata-only articles make no calls, and insufficient model outcomes are terminal cached results", async (t) => {
  const store = storeFor(t);
  const [short, metadata, eligible] = addArticles(store, 3);
  store.db
    .prepare("UPDATE articles SET text='Too short' WHERE id=?")
    .run(short.id);
  store.db
    .prepare("UPDATE articles SET content_basis='metadata' WHERE id=?")
    .run(metadata.id);
  for (const article of [short, metadata]) {
    const summary = await processArticleSummary(store, article.id, {
      config: () => config,
      now: () => now,
      call: async () => assert.fail("Insufficient source must not fetch"),
    });
    assert.equal(summary.status, "insufficient");
  }
  const summary = await processArticleSummary(store, eligible.id, {
    config: () => config,
    now: () => now,
    call: async () => ({ ...result, outcome: "insufficient", text: "" }),
  });
  assert.equal(summary.status, "insufficient");
  assert.equal(summary.canGenerate, false);
  assert.equal(summary.text, undefined);
  assert.equal(state(store).state.ready, 0);
  assert.equal(state(store).state.failed, 0);
  await processArticleSummary(store, eligible.id, {
    config: () => config,
    now: () => now,
    call: async () => assert.fail("Terminal insufficiency must not retry"),
  });
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM summary_attempts").get()
      ?.count,
    1,
  );
});

test("concurrent connections share one global lease while duplicate clicks on the pending input are idempotent", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-summary-concurrency-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "monitor.sqlite");
  const first = new MonitorStore(path, false);
  const second = new MonitorStore(path, false);
  t.after(() => {
    first.db.close();
    second.db.close();
  });
  const [a, b] = addArticles(first, 2);
  const pending = gate();
  let calls = 0;
  const request = processArticleSummary(first, a.id, {
    config: () => config,
    now: () => now,
    call: async () => {
      calls++;
      await pending.wait;
      return result;
    },
  });
  assert.equal(
    (
      await processArticleSummary(second, a.id, {
        config: () => config,
        now: () => now,
        call: async () => assert.fail("Duplicate must not fetch"),
      })
    ).status,
    "pending",
  );
  await assert.rejects(
    processArticleSummary(second, b.id, {
      config: () => config,
      now: () => now,
      call: async () => assert.fail("Concurrent summary must not fetch"),
    }),
    /déjà en cours/,
  );
  assert.equal(state(second).summaries.get(b.id)?.canGenerate, false);
  pending.release();
  assert.equal((await request).status, "ready");
  assert.equal(calls, 1);
  assert.equal(state(second).state.running, false);
  assert.equal(state(second).summaries.get(b.id)?.canGenerate, true);
});

test("the full input and output ceiling is reserved atomically and cannot exceed the monthly cap", async (t) => {
  const store = storeFor(t);
  const [a, b] = addArticles(store, 2);
  const capped = { ...config, monthlyBudgetUsd: reservedUsd };
  assert.throws(
    () =>
      claimSummary(
        store,
        a.id,
        { ...capped, monthlyBudgetUsd: reservedUsd - 1e-9 },
        now,
      ),
    /budget mensuel/,
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM summary_attempts").get()
      ?.count,
    0,
  );
  await processArticleSummary(store, a.id, {
    config: () => capped,
    now: () => now,
    call: async () => ({
      ...result,
      inputTokens: SUMMARY_MAX_INPUT_TOKENS,
      outputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    }),
  });
  const exhausted = summarySnapshot(store, undefined, capped, now);
  assert.equal(exhausted.state.spentUsd, reservedUsd);
  assert.equal(exhausted.state.reservedUsd, 0);
  assert.equal(exhausted.state.budgetBlocked, true);
  assert.equal(exhausted.summaries.get(b.id)?.canGenerate, false);
  await assert.rejects(
    processArticleSummary(store, b.id, {
      config: () => capped,
      now: () => now,
      call: async () => assert.fail("No budget remains"),
    }),
    /budget mensuel/,
  );
});

test("unknown failures retain their reservations and each explicit retry creates a separate bounded attempt", async (t) => {
  const store = storeFor(t);
  const [article] = addArticles(store);
  let calls = 0;
  const failed = await processArticleSummary(store, article.id, {
    config: () => config,
    now: () => now,
    call: async () => {
      calls++;
      throw new Error(`Secret ${config.apiKey} and raw ${content}`);
    },
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.canGenerate, true);
  assert.equal(state(store).state.failed, 1);
  assert.equal(state(store).state.reservedUsd, reservedUsd);
  const exposed = JSON.stringify(store.snapshot());
  assert.equal(exposed.includes(config.apiKey), false);
  assert.equal(exposed.includes(content), false);
  state(store);
  store.snapshot();
  assert.equal(calls, 1);
  const retried = await processArticleSummary(store, article.id, {
    config: () => config,
    now: () => now,
    call: async () => {
      calls++;
      return result;
    },
  });
  assert.equal(retried.status, "ready");
  assert.equal(calls, 2);
  assert.equal(state(store).state.reservedUsd, reservedUsd);
  assert.equal(state(store).state.spentUsd, actualUsd);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM summary_attempts").get()
      ?.count,
    2,
  );
});

test("guaranteed preflight failures release their reservation while malformed responses remain conservative", async (t) => {
  const store = storeFor(t);
  const [article] = addArticles(store);
  await processArticleSummary(store, article.id, {
    config: () => config,
    now: () => now,
    call: async () => {
      throw new SummaryRequestError("Synthetic preflight error", true);
    },
  });
  assert.equal(state(store).state.reservedUsd, 0);
  assert.equal(state(store).state.spentUsd, 0);
  const malformed = await processArticleSummary(store, article.id, {
    config: () => config,
    now: () => now,
    call: async () => ({
      ...result,
      outputTokens: SUMMARY_MAX_OUTPUT_TOKENS + 1,
    }),
  });
  assert.equal(malformed.status, "failed");
  assert.equal(malformed.text, undefined);
  assert.equal(state(store).state.reservedUsd, reservedUsd);
  assert.equal(state(store).state.ready, 0);
});

test("expired claims become visibly failed without GET writes and late completion cannot overwrite a retry", (t) => {
  const store = storeFor(t);
  const [article] = addArticles(store);
  const old = claimSummary(store, article.id, config, now)!;
  const later = now + SUMMARY_LEASE_MS;
  const before = store.db
    .prepare("SELECT total_changes() AS count")
    .get()?.count;
  assert.equal(state(store, later).summaries.get(article.id)?.status, "failed");
  assert.equal(state(store, later).state.running, false);
  assert.equal(
    store.db.prepare("SELECT total_changes() AS count").get()?.count,
    before,
  );
  const replacement = claimSummary(store, article.id, config, later)!;
  assert.notEqual(replacement.id, old.id);
  assert.equal(settleSummary(store, old, result, later), false);
  assert.equal(failSummary(store, old, "Late failure", false, later), false);
  assert.equal(settleSummary(store, replacement, result, later), true);
  assert.equal(
    state(store, later).summaries.get(article.id)?.text,
    result.text,
  );
  assert.equal(state(store, later).state.reservedUsd, reservedUsd);
  assert.equal(state(store, later).state.spentUsd, actualUsd);
});

test("a result for stale content is cached but never shown as the current article's summary", async (t) => {
  const store = storeFor(t);
  const [article] = addArticles(store);
  const pending = gate();
  const request = processArticleSummary(store, article.id, {
    config: () => config,
    now: () => now,
    call: async () => {
      await pending.wait;
      return result;
    },
  });
  store.db
    .prepare("UPDATE articles SET text=?,revision=revision+1 WHERE id=?")
    .run(
      `${content} A later correction changes the available facts.`,
      article.id,
    );
  pending.release();
  const returned = await request;
  assert.equal(returned.status, "available");
  assert.equal(returned.text, undefined);
  assert.match(returned.reason ?? "", /contenu a changé/);
  assert.equal(store.snapshot().articles[0].summary?.text, undefined);
  assert.equal(state(store).state.ready, 0);
  assert.equal(state(store).state.spentUsd, actualUsd);
  assert.equal(
    store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM summary_cache WHERE status='success'",
      )
      .get()?.count,
    1,
  );
});

test("summary caching ignores profile, feed and personal actions and generation leaves those states untouched", async (t) => {
  const store = storeFor(t);
  const [article] = addArticles(store);
  const feedId = store.saveCustomFeed(null, {
    ...GENERAL_FEED,
    name: "Synthetic custom",
    instructions: "Synthetic interest",
  });
  store.setArticleState(article.id, "saved", true);
  store.setArticleState(article.id, "is_read", true);
  store.setArticleState(article.id, "feedback", "off_topic");
  store.setFeedFeedback(article.id, feedId, "relevant");
  const before = store.db
    .prepare("SELECT * FROM articles WHERE id=?")
    .get(article.id);
  const feedback = store.db.prepare("SELECT * FROM feed_feedback").all();
  await processArticleSummary(store, article.id, {
    config: () => config,
    now: () => now,
    call: async () => result,
  });
  assert.deepEqual(
    store.db.prepare("SELECT * FROM articles WHERE id=?").get(article.id),
    before,
  );
  assert.deepEqual(
    store.db.prepare("SELECT * FROM feed_feedback").all(),
    feedback,
  );
  store.setProfile({
    keywords: ["different"],
    excludeKeywords: [],
    minScore: 3,
    matchScope: "title_excerpt",
  });
  const feed = store.listCustomFeeds().find((feed) => feed.id === feedId)!;
  store.saveCustomFeed(
    feedId,
    { ...feed, instructions: "Changed feed instructions" },
    feed.revision,
  );
  store.acknowledgeChanges([article]);
  const cached = await processArticleSummary(store, article.id, {
    config: () => config,
    now: () => now,
    call: async () =>
      assert.fail("Unrelated personal settings must not generate again"),
  });
  assert.equal(cached.text, result.text);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM summary_attempts").get()
      ?.count,
    1,
  );
});

test("UTC month accounting settles in the request's month and survives reopening", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-summary-reopen-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "monitor.sqlite");
  const original = new MonitorStore(path, false);
  const [article] = addArticles(original);
  const started = Date.parse("2026-09-30T23:59:50Z");
  const finished = Date.parse("2026-10-01T00:00:10Z");
  const claim = claimSummary(original, article.id, config, started)!;
  settleSummary(original, claim, result, finished);
  assert.equal(state(original, started).state.spentUsd, actualUsd);
  assert.equal(state(original, finished).state.spentUsd, 0);
  const previous = state(original, started);
  original.db.close();
  const reopened = new MonitorStore(path, false);
  try {
    assert.deepEqual(state(reopened, started), previous);
    assert.equal(
      state(reopened, finished).summaries.get(article.id)?.status,
      "ready",
    );
  } finally {
    reopened.db.close();
  }
});

test("invalid IDs and disabled configuration cannot create a ledger entry", async (t) => {
  const store = storeFor(t);
  const [article] = addArticles(store);
  for (const id of ["", "missing", ` ${article.id}`, "x".repeat(201)])
    await assert.rejects(
      processArticleSummary(store, id, {
        config: () => config,
        now: () => now,
        call: async () => assert.fail("Unknown article"),
      }),
      /Publication inconnue/,
    );
  for (const invalid of [
    { ...config, apiKey: null },
    { ...config, monthlyBudgetUsd: 0 },
    { ...config, monthlyBudgetUsd: -1 },
    { ...config, error: "Invalid configuration" },
  ])
    await assert.rejects(
      processArticleSummary(store, article.id, {
        config: () => invalid,
        now: () => now,
        call: async () => assert.fail("Invalid configuration"),
      }),
    );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM summary_attempts").get()
      ?.count,
    0,
  );
});
