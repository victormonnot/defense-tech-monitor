import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  JEV_MODEL,
  JEV_NANODOLLARS_PER_TOKEN,
  JevRequestError,
} from "../src/lib/jev-client";
import {
  claimJev,
  failJev,
  JEV_LEASE_MS,
  JEV_RESERVATION_NANOS,
  jevSnapshot,
  retryJevFailures,
  setJevMode,
  settleJev,
} from "../src/lib/jev-store";
import { processJevBatch } from "../src/lib/jev-worker";
import type { JevResult } from "../src/lib/jev-types";
import { MonitorStore } from "../src/lib/store";

const config = {
  apiKey: "synthetic-key-never-sent",
  monthlyBudgetUsd: 5,
  error: null,
};
const now = Date.parse("2026-09-25T12:00:00.000Z");
const result: JevResult = {
  score: 2.4,
  confidence: 0.9,
  kind: "technical",
  kindConfidence: 0.85,
  model: JEV_MODEL,
  inputTokens: 1000,
};
const reservedUsd = JEV_RESERVATION_NANOS / 1e9;

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
      title: `Synthetic radar ${index}`,
      publishedAt: null,
      text: `Synthetic technical excerpt ${index}`,
      excerpt: `Synthetic excerpt ${index}`,
      language: "en",
      format: "article" as const,
      contentHash: `hash-${index}`,
    })),
    new Date(now).toISOString(),
  );
  return sourceId;
}
function state(store: MonitorStore, time = now) {
  return jevSnapshot(store, undefined, undefined, config, time).state;
}
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

test("Jev starts off, never calls the service on snapshots and requires valid configuration to enable", async (t) => {
  const store = storeFor(t);
  addArticles(store);
  assert.equal(state(store).mode, "off");
  assert.equal(state(store).pending, 1);
  assert.equal(
    await processJevBatch(store, {
      config: () => config,
      now: () => now,
      call: async () => assert.fail("Off must not fetch"),
    }),
    0,
  );
  for (const invalid of [
    { ...config, apiKey: null },
    { ...config, monthlyBudgetUsd: 0 },
    { ...config, monthlyBudgetUsd: NaN },
    { ...config, error: "Invalid configuration" },
  ])
    assert.throws(() => setJevMode(store, "personal", invalid));
  assert.throws(
    () => setJevMode(store, "invalid" as "off", config),
    /invalide/,
  );
  setJevMode(store, "off", { ...config, apiKey: null, monthlyBudgetUsd: 0 });
  const before = store.db
    .prepare("SELECT total_changes() AS count")
    .get()?.count;
  store.snapshot();
  store.snapshot();
  assert.equal(
    store.db.prepare("SELECT total_changes() AS count").get()?.count,
    before,
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM jev_attempts").get()?.count,
    0,
  );
  assert.ok(!JSON.stringify(state(store)).includes(config.apiKey));
});

test("a valid result settles only reported usage and cached results apply only in personal mode", async (t) => {
  const store = storeFor(t);
  addArticles(store);
  setJevMode(store, "compare", config);
  let calls = 0;
  await processJevBatch(store, {
    config: () => config,
    now: () => now,
    call: async () => {
      calls++;
      assert.equal(state(store).reservedUsd, reservedUsd);
      return result;
    },
  });
  assert.equal(calls, 1);
  assert.equal(state(store).ready, 1);
  assert.equal(state(store).pending, 0);
  assert.equal(state(store).inputTokens, 1000);
  assert.equal(state(store).spentUsd, (1000 * JEV_NANODOLLARS_PER_TOKEN) / 1e9);
  assert.equal(state(store).reservedUsd, 0);
  assert.equal(store.snapshot().articles[0].jev?.applied, false);
  setJevMode(store, "personal", config);
  assert.equal(store.snapshot().articles[0].jev?.applied, true);
  setJevMode(store, "off", config);
  assert.equal(store.snapshot().articles[0].jev?.applied, false);
  assert.equal(store.snapshot().articles[0].jev?.score, result.score);
  assert.equal(
    await processJevBatch(store, {
      config: () => config,
      now: () => now,
      call: async () => assert.fail("Cache must not fetch"),
    }),
    0,
  );
});

test("profile previews are rules-only on both sides and never mutate or spend", async (t) => {
  const store = storeFor(t);
  addArticles(store);
  store.setProfile({
    keywords: ["unmatched-topic"],
    excludeKeywords: [],
    minScore: 99,
  });
  setJevMode(store, "personal", config);
  await processJevBatch(store, {
    config: () => config,
    now: () => now,
    call: async () => result,
  });
  assert.equal(store.snapshot().stats.selected, 1);
  const before = store.db
    .prepare("SELECT total_changes() AS count")
    .get()?.count;
  const preview = store.previewProfile(store.profile());
  assert.equal(preview.currentSelected, 0);
  assert.equal(preview.selected, 0);
  assert.equal(store.snapshot(store.profile()).articles[0].jev, undefined);
  assert.equal(
    store.db.prepare("SELECT total_changes() AS count").get()?.count,
    before,
  );
  assert.equal(state(store).ready, 1);
});

test("cache matching follows current content and profile while personal actions preserve it", async (t) => {
  const store = storeFor(t);
  addArticles(store);
  const profile = store.profile();
  setJevMode(store, "personal", config);
  await processJevBatch(store, {
    config: () => config,
    now: () => now,
    call: async () => result,
  });
  const article = store.snapshot().articles[0];
  store.setArticleState(article.id, "saved", true);
  store.setArticleState(article.id, "is_read", true);
  store.setArticleState(article.id, "feedback", "relevant");
  store.acknowledgeChanges([article]);
  assert.equal(state(store).ready, 1);
  store.setProfile({ ...profile, keywords: ["different reader interest"] });
  assert.equal(store.snapshot().articles[0].jev, undefined);
  assert.equal(state(store).pending, 1);
  store.setProfile(profile);
  assert.equal(state(store).ready, 1);
  store.db
    .prepare("UPDATE articles SET text='Changed available text' WHERE id=?")
    .run(article.id);
  assert.equal(state(store).ready, 0);
  assert.equal(store.snapshot().articles[0].jev, undefined);
});

test("cached badges expose the exact input scope and truncation without revealing request text or credentials", async (t) => {
  const store = storeFor(t);
  addArticles(store);
  store.db
    .prepare("UPDATE articles SET text=?,excerpt=?")
    .run("Synthetic private body ".repeat(5000), "Short synthetic excerpt");
  setJevMode(store, "compare", config);
  await processJevBatch(store, {
    config: () => config,
    now: () => now,
    call: async () => result,
  });
  const full = store.snapshot().articles[0].jev!;
  assert.equal(full.scope, "all_text");
  assert.equal(full.truncated, true);
  assert.ok(!JSON.stringify(full).includes("Synthetic private body"));
  assert.ok(!JSON.stringify(full).includes(config.apiKey));
  assert.equal(Object.hasOwn(full, "inputTokens"), false);
  store.setProfile({ ...store.profile(), matchScope: "title_excerpt" });
  assert.equal(store.snapshot().articles[0].jev, undefined);
  await processJevBatch(store, {
    config: () => config,
    now: () => now,
    call: async () => result,
  });
  const limited = store.snapshot().articles[0].jev!;
  assert.equal(limited.scope, "title_excerpt");
  assert.equal(limited.truncated, false);
});

test("atomic cross-process claims reserve the full ceiling and never overlap or exceed budget", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-jev-lock-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "monitor.sqlite");
  const first = new MonitorStore(path, false);
  const second = new MonitorStore(path, false);
  t.after(() => {
    first.db.close();
    second.db.close();
  });
  addArticles(first, 2);
  const exact = { ...config, monthlyBudgetUsd: reservedUsd };
  setJevMode(first, "compare", exact);
  assert.equal(
    claimJev(first, { ...exact, monthlyBudgetUsd: reservedUsd - 1e-9 }, now),
    null,
  );
  const claim = claimJev(first, exact, now)!;
  assert.ok(claim);
  assert.equal(claimJev(second, exact, now), null);
  assert.equal(
    jevSnapshot(second, undefined, undefined, exact, now).state.reservedUsd,
    reservedUsd,
  );
  settleJev(first, claim, { ...result, inputTokens: 64000 }, now);
  assert.equal(claimJev(second, exact, now), null);
  const exhausted = jevSnapshot(second, undefined, undefined, exact, now).state;
  assert.equal(exhausted.spentUsd, reservedUsd);
  assert.equal(exhausted.reservedUsd, 0);
  assert.equal(exhausted.budgetBlocked, true);
  assert.equal(exhausted.pending, 1);
});

test("unknown failures pause all work and retries retain every previous reservation", async (t) => {
  const store = storeFor(t);
  addArticles(store, 2);
  setJevMode(store, "compare", config);
  let calls = 0;
  const options = {
    config: () => config,
    now: () => now,
    call: async () => {
      calls++;
      throw new Error(`do not expose ${config.apiKey}`);
    },
  };
  assert.equal(await processJevBatch(store, options), 1);
  assert.equal(state(store).failed, 1);
  assert.equal(state(store).reservedUsd, reservedUsd);
  assert.ok(state(store).lastError);
  assert.ok(!JSON.stringify(state(store)).includes(config.apiKey));
  assert.equal(await processJevBatch(store, options), 0);
  assert.equal(calls, 1);
  assert.equal(retryJevFailures(store, now), 1);
  assert.equal(state(store).lastError, null);
  assert.equal(await processJevBatch(store, options), 1);
  assert.equal(state(store).reservedUsd, 2 * reservedUsd);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM jev_attempts").get()?.count,
    2,
  );
});

test("guaranteed before-request failures release only their own reservation and malformed responses retain theirs", async (t) => {
  const store = storeFor(t);
  addArticles(store);
  setJevMode(store, "compare", config);
  await processJevBatch(store, {
    config: () => config,
    now: () => now,
    call: async () => {
      throw new JevRequestError("Synthetic validation error", true);
    },
  });
  assert.equal(state(store).spentUsd, 0);
  assert.equal(state(store).reservedUsd, 0);
  assert.equal(state(store).failed, 1);
  retryJevFailures(store, now);
  await processJevBatch(store, {
    config: () => config,
    now: () => now,
    call: async () => ({ ...result, model: "wrong-model" }),
  });
  assert.equal(state(store).ready, 0);
  assert.equal(state(store).failed, 1);
  assert.equal(state(store).reservedUsd, reservedUsd);
});

test("expired claims fail conservatively, never auto-retry, and reject late settlement", (t) => {
  const store = storeFor(t);
  addArticles(store);
  setJevMode(store, "compare", config);
  const claim = claimJev(store, config, now)!;
  const expiredAt = now + JEV_LEASE_MS;
  const changes = store.db
    .prepare("SELECT total_changes() AS count")
    .get()?.count;
  assert.equal(state(store, expiredAt).failed, 1);
  assert.equal(state(store, expiredAt).running, false);
  assert.equal(
    store.db.prepare("SELECT total_changes() AS count").get()?.count,
    changes,
  );
  assert.equal(claimJev(store, config, expiredAt), null);
  assert.equal(settleJev(store, claim, result, expiredAt), false);
  assert.equal(state(store, expiredAt).reservedUsd, reservedUsd);
  retryJevFailures(store, expiredAt);
  const replacement = claimJev(store, config, expiredAt)!;
  assert.notEqual(replacement.id, claim.id);
  assert.equal(settleJev(store, claim, result, expiredAt), false);
  assert.equal(failJev(store, claim, "Late failure", false, expiredAt), false);
  assert.equal(settleJev(store, replacement, result, expiredAt), true);
  assert.equal(state(store, expiredAt).reservedUsd, reservedUsd);
  assert.equal(state(store, expiredAt).ready, 1);
});

test("pausing during a request lets that request finish and stops the next paid call", async (t) => {
  const store = storeFor(t);
  addArticles(store, 3);
  setJevMode(store, "compare", config);
  const pending = gate();
  let calls = 0;
  const batch = processJevBatch(store, {
    config: () => config,
    now: () => now,
    call: async () => {
      calls++;
      await pending.wait;
      return result;
    },
  });
  setJevMode(store, "off", config);
  pending.release();
  assert.equal(await batch, 1);
  assert.equal(calls, 1);
  assert.equal(state(store).ready, 1);
  assert.equal(state(store).pending, 2);
});

test("stale input results stay cached without applying and stale-input failures remain explicitly recoverable", async (t) => {
  for (const fails of [false, true])
    await t.test(fails ? "failure" : "success", async (t) => {
      const store = storeFor(t);
      addArticles(store);
      setJevMode(store, "personal", config);
      const pending = gate();
      const batch = processJevBatch(store, {
        config: () => config,
        now: () => now,
        call: async () => {
          await pending.wait;
          if (fails) throw new Error("Synthetic failure");
          return result;
        },
      });
      store.setProfile({ ...store.profile(), keywords: ["new interests"] });
      setJevMode(store, "off", config);
      pending.release();
      await batch;
      assert.equal(store.snapshot().articles[0].jev, undefined);
      assert.equal(state(store).pending, 1);
      if (fails) {
        assert.equal(state(store).failed, 0);
        assert.ok(state(store).lastError);
        assert.equal(retryJevFailures(store, now), 1);
        assert.equal(state(store).lastError, null);
        setJevMode(store, "compare", config);
        assert.ok(claimJev(store, config, now));
      }
    });
});

test("each worker tick processes at most five requests and rereads profile before each claim", async (t) => {
  const store = storeFor(t);
  addArticles(store, 7);
  setJevMode(store, "compare", config);
  let calls = 0;
  const profiles: string[][] = [];
  assert.equal(
    await processJevBatch(store, {
      config: () => config,
      now: () => now,
      call: async (request) => {
        calls++;
        profiles.push(request.state.reader.interests);
        if (calls === 1)
          store.setProfile({ ...store.profile(), keywords: ["changed"] });
        return result;
      },
    }),
    5,
  );
  assert.equal(calls, 5);
  assert.notDeepEqual(profiles[0], ["changed"]);
  assert.deepEqual(
    profiles.slice(1),
    Array.from({ length: 4 }, () => ["changed"]),
  );
  assert.equal(state(store).ready, 4);
  assert.equal(state(store).pending, 3);
});

test("identical classification inputs share one paid result across publications", async (t) => {
  const store = storeFor(t);
  addArticles(store, 2);
  store.db
    .prepare(
      "UPDATE articles SET title='Same synthetic title',text='Same synthetic text',excerpt='Same excerpt'",
    )
    .run();
  setJevMode(store, "compare", config);
  let calls = 0;
  await processJevBatch(store, {
    config: () => config,
    now: () => now,
    call: async () => {
      calls++;
      return result;
    },
  });
  assert.equal(calls, 1);
  assert.equal(state(store).ready, 2);
  assert.equal(state(store).pending, 0);
});

test("UTC month accounting keeps late settlements in their original request month", (t) => {
  const store = storeFor(t);
  addArticles(store, 2);
  setJevMode(store, "compare", config);
  const before = Date.parse("2026-09-30T23:59:50Z");
  const after = Date.parse("2026-10-01T00:00:10Z");
  const claim = claimJev(store, config, before)!;
  assert.equal(state(store, before).reservedUsd, reservedUsd);
  assert.equal(state(store, after).reservedUsd, 0);
  settleJev(store, claim, result, after);
  assert.equal(
    state(store, before).spentUsd,
    (1000 * JEV_NANODOLLARS_PER_TOKEN) / 1e9,
  );
  assert.equal(state(store, after).spentUsd, 0);
  assert.equal(state(store, after).month, "2026-10");
  assert.ok(claimJev(store, config, after));
  assert.equal(state(store, after).reservedUsd, reservedUsd);
});

test("cached analyses, mode and conservative budget history survive reopening", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-jev-reopen-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "monitor.sqlite");
  const original = new MonitorStore(path, false);
  addArticles(original, 2);
  setJevMode(original, "personal", config);
  const success = claimJev(original, config, now)!;
  settleJev(original, success, result, now);
  const failure = claimJev(original, config, now)!;
  failJev(original, failure, "Synthetic safe failure", false, now);
  const before = state(original);
  const analyses = original.snapshot().articles.map((article) => article.jev);
  original.db.close();
  const reopened = new MonitorStore(path, false);
  try {
    assert.deepEqual(state(reopened), before);
    assert.deepEqual(
      reopened.snapshot().articles.map((article) => article.jev),
      analyses,
    );
    assert.equal(
      await processJevBatch(reopened, {
        config: () => config,
        now: () => now,
        call: async () => assert.fail("Paused failure must persist"),
      }),
      0,
    );
  } finally {
    reopened.db.close();
  }
});
