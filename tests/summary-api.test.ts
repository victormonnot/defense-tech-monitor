import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/monitor/route";
import { SUMMARY_MODEL } from "../src/lib/summary-client";
import { DEFAULT_SUMMARY_MODEL } from "../src/lib/summary-models";
import { MonitorStore } from "../src/lib/store";

test("summary API checks origin, makes no GET calls and returns persisted failed states as errors", async (t) => {
  const store = new MonitorStore(":memory:", false);
  const globals = globalThis as typeof globalThis & {
    monitorStore?: MonitorStore;
  };
  const previousStore = globals.monitorStore;
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousBudget = process.env.DTM_SUMMARY_MONTHLY_BUDGET_USD;
  const previousModel = process.env.DTM_SUMMARY_MODEL;
  globals.monitorStore = store;
  process.env.OPENAI_API_KEY = "synthetic-summary-api-key";
  process.env.DTM_SUMMARY_MONTHLY_BUDGET_USD = "3";
  process.env.DTM_SUMMARY_MODEL = DEFAULT_SUMMARY_MODEL;
  t.after(() => {
    globals.monitorStore = previousStore;
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousBudget === undefined)
      delete process.env.DTM_SUMMARY_MONTHLY_BUDGET_USD;
    else process.env.DTM_SUMMARY_MONTHLY_BUDGET_USD = previousBudget;
    if (previousModel === undefined) delete process.env.DTM_SUMMARY_MODEL;
    else process.env.DTM_SUMMARY_MODEL = previousModel;
    store.db.close();
  });
  let calls = 0;
  let fail = false;
  globalThis.fetch = async (url, request) => {
    calls++;
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    assert.equal(request?.method, "POST");
    if (fail)
      return new Response(
        JSON.stringify({
          error: "Untrusted provider body synthetic-summary-api-key",
        }),
        { status: 503 },
      );
    return new Response(
      JSON.stringify({
        model: SUMMARY_MODEL,
        status: "completed",
        usage: { input_tokens: 700, output_tokens: 80 },
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  outcome: "summary",
                  text: "Le fabricant présente un prototype maritime autonome. Selon ses ingénieurs, des essais supplémentaires sont encore nécessaires.",
                }),
              },
            ],
          },
        ],
      }),
      { status: 200 },
    );
  };
  const base = "http://127.0.0.1:3001";
  async function post(body: unknown, origin = base) {
    return POST(
      new NextRequest(`${base}/api/monitor`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:3001",
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
  }
  const source = store.addSource({
    name: "Synthetic source",
    siteUrl: "https://example.test",
    feedUrl: "https://example.test/feed",
    language: "en",
  });
  store.upsertEntries(
    source,
    ["one", "two"].map((id) => ({
      guid: id,
      url: `https://example.test/${id}`,
      title: `Synthetic prototype ${id}`,
      publishedAt: null,
      text: "The synthetic manufacturer described an autonomous maritime prototype using navigation sensors. Its engineers reported a controlled demonstration and said additional field tests remain necessary. ".repeat(
        4,
      ),
      excerpt: "Synthetic collected excerpt",
      language: "en",
      format: "article" as const,
      contentHash: `fixture-${id}`,
    })),
    "2026-09-25T12:00:00Z",
  );
  const [first, second] = store.snapshot().articles;
  const action = { action: "generateSummary", id: first.id };
  assert.equal((await post(action, "https://outside.example")).status, 403);
  const changes = store.db
    .prepare("SELECT total_changes() AS count")
    .get()?.count;
  const initial = await GET();
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("cache-control"), "no-store");
  assert.equal(
    store.db.prepare("SELECT total_changes() AS count").get()?.count,
    changes,
  );
  assert.equal(calls, 0);
  for (const id of [undefined, null, 42, "", "missing", "x".repeat(201)])
    assert.equal((await post({ action: "generateSummary", id })).status, 400);
  assert.equal(calls, 0);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM summary_attempts").get()
      ?.count,
    0,
  );
  const generatedResponse = await post(action);
  assert.equal(generatedResponse.status, 200);
  const generated = await generatedResponse.json();
  assert.equal(
    generated.snapshot.articles.find(
      (article: { id: string }) => article.id === first.id,
    ).summary.status,
    "ready",
  );
  assert.equal(generated.error, undefined);
  assert.equal(calls, 1);
  await post(action);
  await GET();
  assert.equal(calls, 1);
  fail = true;
  const failedResponse = await post({
    action: "generateSummary",
    id: second.id,
  });
  assert.equal(failedResponse.status, 200);
  const failed = await failedResponse.json();
  assert.equal(
    failed.snapshot.articles.find(
      (article: { id: string }) => article.id === second.id,
    ).summary.status,
    "failed",
  );
  assert.equal(typeof failed.error, "string");
  assert.equal(failed.message, undefined);
  assert.equal(
    JSON.stringify(failed).includes("Untrusted provider body"),
    false,
  );
  assert.equal(
    JSON.stringify(failed).includes("synthetic-summary-api-key"),
    false,
  );
  assert.equal(calls, 2);
  fail = false;
  const retried = await post({ action: "generateSummary", id: second.id });
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).snapshot.summaries.ready, 2);
  assert.equal(calls, 3);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM summary_attempts").get()
      ?.count,
    3,
  );
});
