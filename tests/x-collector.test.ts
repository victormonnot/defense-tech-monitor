import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { collectSources } from "../src/lib/collector";
import { MonitorStore } from "../src/lib/store";
import type { XFetch } from "../src/lib/x-client";
import { xSnapshot } from "../src/lib/x-store";
import { buildSummaryInput } from "../src/lib/summary-client";

const config = { apiKey: "synthetic-secret", monthlyBudgetUsd: 1, error: null };
const start = Date.parse("2026-09-28T10:00:00Z");
const post = (id: string) => ({
  id,
  text: `Synthetic drone publication ${id}.`,
  created_at: "2026-09-28T09:00:00Z",
  lang: "en",
});
function setup(t: TestContext) {
  const store = new MonitorStore(":memory:", false);
  t.after(() => store.db.close());
  const id = store.addSource({
    name: "Test X",
    siteUrl: "https://twitter.com/Monitor_Test",
    feedUrl: null,
    language: "und",
  });
  return { store, id };
}
const noWebsite = async () => {
  throw new Error("X must not use website collection");
};
const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("X starts with latest posts then persists paginated incremental cursors without gaps", async (t) => {
  const { store, id } = setup(t);
  const sameId = store.addSource({
    name: "Test X renamed",
    siteUrl: "@monitor_test",
    feedUrl: null,
    language: "und",
  });
  assert.equal(sameId, id);
  assert.equal(store.sources()[0].collectionKind, "x");
  assert.equal(store.sources()[0].siteUrl, "https://x.com/monitor_test");
  let requests = 0;
  const urls: URL[] = [];
  const pages = [
    {
      data: [post("102"), post("101")],
      meta: { result_count: 2, newest_id: "102", next_token: "older-initial" },
    },
    {
      data: [post("105"), post("104")],
      meta: { result_count: 2, newest_id: "105", next_token: "catchup" },
    },
    { data: [post("103")], meta: { result_count: 1, newest_id: "103" } },
    { meta: { result_count: 0 } },
  ];
  const fetcher: XFetch = async (input) => {
    requests++;
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname.includes("/by/username/"))
      return response({ data: { id: "123", username: "Monitor_Test" } });
    return response(pages.shift());
  };
  async function collect(step: number) {
    return collectSources(store, noWebsite, 15, {
      now: () => start + step * 16 * 60_000,
      xConfig: config,
      xFetch: fetcher,
    });
  }
  assert.equal((await collect(0)).added, 2);
  assert.equal(requests, 2);
  const cursor = () =>
    store.db.prepare("SELECT * FROM x_sources WHERE source_id=?").get(id)!;
  assert.equal(cursor().since_id, "102");
  assert.equal(cursor().next_token, null);
  const article = store.snapshot().articles[0];
  assert.equal(article.format, "post");
  assert.equal(article.language, "en");
  store.setArticleState(article.id, "saved", true);
  assert.equal((await collect(0)).skipped, 1);
  assert.equal(requests, 2);
  assert.equal((await collect(1)).added, 2);
  assert.equal(urls[2].searchParams.get("since_id"), "102");
  assert.equal(cursor().since_id, "102");
  assert.equal(cursor().next_token, "catchup");
  assert.equal(cursor().sweep_newest_id, "105");
  assert.equal((await collect(2)).added, 1);
  assert.equal(urls[3].searchParams.get("pagination_token"), "catchup");
  assert.equal(urls[3].searchParams.get("since_id"), "102");
  assert.equal(cursor().since_id, "105");
  assert.equal(cursor().next_token, null);
  assert.equal((await collect(3)).added, 0);
  assert.equal(urls[4].searchParams.get("since_id"), "105");
  assert.equal(store.snapshot().articles.length, 5);
  assert.equal(
    store.snapshot().articles.find((a) => a.id === article.id)?.saved,
    true,
  );
  assert.equal(xSnapshot(store.db, config, start).spentUsd, 0.035);
  assert.equal(
    buildSummaryInput({ ...article, text: article.excerpt! }),
    null,
    "a short tweet is not enough for a summary",
  );
});

test("missing X setup never calls the API and does not prevent other sources collecting", async (t) => {
  const { store } = setup(t);
  let calls = 0;
  const result = await collectSources(store, noWebsite, 15, {
    now: () => start,
    xConfig: { ...config, monthlyBudgetUsd: 0 },
    xFetch: async () => {
      calls++;
      throw new Error("Unexpected API");
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.failed, 1);
  assert.equal(store.sources()[0].status, "error");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM x_requests").get()!.n,
    0,
  );
});

test("X charges an uncertain request conservatively and leaves the cursor unchanged for retry", async (t) => {
  const { store, id } = setup(t);
  store.db
    .prepare(
      "INSERT INTO x_sources (source_id,user_id,username,since_id) VALUES (?,?,?,?)",
    )
    .run(id, "123", "monitor_test", "102");
  const result = await collectSources(store, noWebsite, 15, {
    now: () => start,
    xConfig: config,
    xFetch: async () => {
      throw new Error("synthetic-secret must never escape");
    },
  });
  assert.equal(result.failed, 1);
  assert.equal(xSnapshot(store.db, config, start).spentUsd, 0.05);
  assert.equal(
    store.db
      .prepare("SELECT since_id FROM x_sources WHERE source_id=?")
      .get(id)!.since_id,
    "102",
  );
  assert.ok(!JSON.stringify(store.snapshot()).includes("synthetic-secret"));
});

test("source disabled while X responds discards publications but records incurred reads", async (t) => {
  const { store, id } = setup(t);
  store.db
    .prepare(
      "INSERT INTO x_sources (source_id,user_id,username) VALUES (?,?,?)",
    )
    .run(id, "123", "monitor_test");
  const result = await collectSources(store, noWebsite, 15, {
    now: () => start,
    xConfig: config,
    xFetch: async () => {
      store.toggleSource(id, false);
      return response({
        data: [post("102")],
        meta: { result_count: 1, newest_id: "102" },
      });
    },
  });
  assert.equal(result.skipped, 1);
  assert.equal(store.snapshot().articles.length, 0);
  assert.equal(xSnapshot(store.db, config, start).spentUsd, 0.005);
  assert.equal(
    store.db
      .prepare("SELECT since_id FROM x_sources WHERE source_id=?")
      .get(id)!.since_id,
    null,
  );
});
