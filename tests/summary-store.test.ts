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
  DEFAULT_SUMMARY_MODEL,
  SUMMARY_MODELS,
  summaryCostNanos,
  summaryReservationNanos,
  type SummaryModel,
} from "../src/lib/summary-models";
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

test("each registered model has an isolated cache while previous default results remain reusable", async (t) => {
  const store = storeFor(t);
  const [article] = addArticles(store);
  const models = Object.keys(SUMMARY_MODELS) as SummaryModel[];
  let calls = 0;
  let expectedSpent = 0;
  for (const model of models) {
    const currentConfig = { ...config, model };
    assert.equal(
      summarySnapshot(store, undefined, currentConfig, now).summaries.get(
        article.id,
      )?.status,
      "available",
    );
    const response = { ...result, model };
    const summary = await processArticleSummary(store, article.id, {
      config: () => currentConfig,
      now: () => now,
      call: async (request) => {
        calls++;
        assert.equal(request.model, model);
        return response;
      },
    });
    expectedSpent += summaryCostNanos(response);
    assert.equal(summary.status, "ready");
    assert.equal(summary.model, model);
    const current = summarySnapshot(store, undefined, currentConfig, now);
    assert.equal(current.state.ready, 1);
    assert.equal(current.state.model, model);
    assert.equal(current.state.spentUsd, expectedSpent / 1e9);
    assert.equal(current.state.reservedUsd, 0);
  }
  for (const model of models) {
    const summary = await processArticleSummary(store, article.id, {
      config: () => ({ ...config, model }),
      now: () => now,
      call: async () =>
        assert.fail("Switching back must reuse the model's cache"),
    });
    assert.equal(summary.model, model);
  }
  const legacy = await processArticleSummary(store, article.id, {
    config: () => config,
    now: () => now,
    call: async () =>
      assert.fail("Configuration without model keeps the default cache"),
  });
  assert.equal(legacy.model, DEFAULT_SUMMARY_MODEL);
  assert.equal(calls, models.length);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM summary_cache").get()
      ?.count,
    models.length,
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM summary_attempts").get()
      ?.count,
    models.length,
  );
});

test("model-specific reservation covers maximal cache-write and output costs", (t) => {
  const store = storeFor(t);
  const [article] = addArticles(store);
  const reservations: Record<SummaryModel, number> = {
    "gpt-4.1-mini-2025-04-14": 26_400_000,
    "gpt-5-nano-2025-08-07": 3_400_000,
    "gpt-5.6-luna": 16_600_000,
    "gpt-6-luna": 8_250_000,
  };
  for (const model of Object.keys(reservations) as SummaryModel[]) {
    const claim = claimSummary(store, article.id, { ...config, model }, now)!;
    assert.equal(summaryReservationNanos(model), reservations[model]);
    assert.equal(
      store.db
        .prepare("SELECT reserved_nanos FROM summary_attempts WHERE id=?")
        .get(claim.id)?.reserved_nanos,
      reservations[model],
    );
    assert.equal(
      settleSummary(
        store,
        claim,
        {
          ...result,
          model,
          inputTokens: SUMMARY_MAX_INPUT_TOKENS,
          outputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
          cachedInputTokens: 0,
          cacheWriteTokens: SUMMARY_MAX_INPUT_TOKENS,
        },
        now,
      ),
      true,
    );
    assert.equal(
      store.db
        .prepare("SELECT settled_nanos FROM summary_attempts WHERE id=?")
        .get(claim.id)?.settled_nanos,
      reservations[model],
    );
  }
});

test("different models consume one shared monthly budget and a global in-flight lease", (t) => {
  const store = storeFor(t);
  const [a, b] = addArticles(store, 2);
  const bounded = { ...config, monthlyBudgetUsd: 0.03 };
  for (const model of ["gpt-6-luna", "gpt-5.6-luna"] as const) {
    const currentConfig = { ...bounded, model };
    const claim = claimSummary(store, a.id, currentConfig, now)!;
    assert.throws(
      () =>
        claimSummary(
          store,
          b.id,
          { ...bounded, model: DEFAULT_SUMMARY_MODEL },
          now,
        ),
      /déjà en cours/,
    );
    settleSummary(
      store,
      claim,
      {
        ...result,
        model,
        inputTokens: SUMMARY_MAX_INPUT_TOKENS,
        outputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
        cacheWriteTokens: SUMMARY_MAX_INPUT_TOKENS,
      },
      now,
    );
  }
  const currentConfig = { ...bounded, model: "gpt-6-luna" as const };
  const current = summarySnapshot(store, undefined, currentConfig, now);
  assert.equal(current.state.spentUsd, 0.02485);
  assert.equal(current.state.reservedUsd, 0);
  assert.equal(current.state.budgetBlocked, true);
  assert.equal(current.summaries.get(a.id)?.status, "ready");
  assert.equal(current.summaries.get(b.id)?.canGenerate, false);
  assert.throws(
    () => claimSummary(store, b.id, currentConfig, now),
    /budget mensuel/,
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM summary_attempts").get()
      ?.count,
    2,
  );
});

test("cache-read and cache-write usage is charged precisely and missing write details are conservative", (t) => {
  const store = storeFor(t);
  const articles = addArticles(store, 3);
  const model = "gpt-6-luna" as const;
  const cases = [
    {
      usage: { cachedInputTokens: 400, cacheWriteTokens: 300 },
      nanos: 121_500,
    },
    { usage: {}, nanos: 175_000 },
    { usage: { cachedInputTokens: 300 }, nanos: 140_500 },
  ];
  for (const [index, fixture] of cases.entries()) {
    const claim = claimSummary(
      store,
      articles[index].id,
      { ...config, model },
      now,
    )!;
    const response = {
      ...result,
      model,
      ...fixture.usage,
      rawBody: "must never persist",
    };
    settleSummary(store, claim, response, now);
    const persisted = JSON.parse(
      String(
        store.db
          .prepare("SELECT result FROM summary_cache WHERE cache_key=?")
          .get(claim.cacheKey)?.result,
      ),
    );
    assert.deepEqual(persisted, { ...result, model, ...fixture.usage });
    assert.equal(
      store.db
        .prepare("SELECT settled_nanos FROM summary_attempts WHERE id=?")
        .get(claim.id)?.settled_nanos,
      fixture.nanos,
    );
  }
  assert.equal(
    summarySnapshot(store, undefined, { ...config, model }, now).state.spentUsd,
    437_000 / 1e9,
  );
});

test("settlement rejects the wrong model and invalid cache accounting without releasing the reservation", (t) => {
  const store = storeFor(t);
  const [article] = addArticles(store);
  const model = "gpt-6-luna" as const;
  const currentConfig = { ...config, model };
  const claim = claimSummary(store, article.id, currentConfig, now)!;
  for (const invalid of [
    { ...result, model: "gpt-5.6-luna" },
    { ...result, model: "unknown" },
    { ...result, model, cachedInputTokens: 800, cacheWriteTokens: 201 },
    { ...result, model, cachedInputTokens: -1 },
    { ...result, model, cacheWriteTokens: 0.5 },
  ]) {
    assert.throws(() => settleSummary(store, claim, invalid, now), /invalide/);
    const current = summarySnapshot(store, undefined, currentConfig, now);
    assert.equal(current.state.spentUsd, 0);
    assert.equal(current.state.reservedUsd, 0.00825);
    assert.equal(current.summaries.get(article.id)?.status, "pending");
  }
  settleSummary(store, claim, { ...result, model }, now);
  store.db
    .prepare("UPDATE summary_cache SET result=? WHERE cache_key=?")
    .run(JSON.stringify(result), claim.cacheKey);
  const mismatched = summarySnapshot(store, undefined, currentConfig, now);
  assert.equal(mismatched.state.ready, 0);
  assert.equal(mismatched.summaries.get(article.id)?.status, "failed");
  assert.equal(mismatched.summaries.get(article.id)?.text, undefined);
});

test("changing the configured model during a request keeps its result only in the original model's cache", async (t) => {
  const store = storeFor(t);
  const [article] = addArticles(store);
  let model: SummaryModel = DEFAULT_SUMMARY_MODEL;
  const pending = gate();
  let calls = 0;
  const request = processArticleSummary(store, article.id, {
    config: () => ({ ...config, model }),
    now: () => now,
    call: async () => {
      calls++;
      await pending.wait;
      return result;
    },
  });
  model = "gpt-6-luna";
  pending.release();
  const returned = await request;
  assert.equal(returned.status, "available");
  assert.equal(returned.text, undefined);
  assert.match(returned.reason ?? "", /modèle de résumé a changé/);
  assert.equal(
    summarySnapshot(store, undefined, { ...config, model }, now).state.ready,
    0,
  );
  assert.equal(
    state(store).summaries.get(article.id)?.model,
    DEFAULT_SUMMARY_MODEL,
  );
  assert.equal(state(store).state.spentUsd, actualUsd);
  assert.equal(calls, 1);
});
