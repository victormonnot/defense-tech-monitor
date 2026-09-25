import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSummaryInput,
  callSummary,
  getSummaryConfig,
  parseSummaryResult,
  SummaryRequestError,
  SUMMARY_MODEL,
  SUMMARY_MAX_INPUT_TOKENS,
  SUMMARY_MAX_OUTPUT_TOKENS,
  SUMMARY_RESERVED_NANODOLLARS,
} from "../src/lib/summary-client";
import type { SummaryInputArticle } from "../src/lib/summary-types";

const article: SummaryInputArticle = {
  id: "publication-1",
  title: "Company announces new inspection robot",
  text: "The company announced a robot for infrastructure inspection. It says the prototype is still being tested. Independent test results were not provided. ".repeat(
    5,
  ),
  sourceName: "Test source",
  language: "en",
  contentBasis: "feed_text",
};
const french =
  "L’entreprise annonce un prototype de robot destiné à l’inspection des infrastructures. Selon elle, les essais sont encore en cours. Le texte ne fournit pas de résultats indépendants.";
const response = () => ({
  model: SUMMARY_MODEL,
  status: "completed",
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: JSON.stringify({ outcome: "summary", text: french }),
        },
      ],
    },
  ],
  usage: { input_tokens: 800, output_tokens: 120 },
});

test("summary credentials and budget are independent from Jev and default to disabled", () => {
  assert.deepEqual(
    getSummaryConfig({
      TYPESAFE_API_KEY: "jev-key",
      DTM_JEV_MONTHLY_BUDGET_USD: "5",
    }),
    { apiKey: null, monthlyBudgetUsd: 0, error: null },
  );
  assert.equal(
    getSummaryConfig({
      OPENAI_API_KEY: "test-key",
      DTM_SUMMARY_MONTHLY_BUDGET_USD: "1",
    }).monthlyBudgetUsd,
    1,
  );
  for (const cap of ["-1", "Infinity", "1e1", "0x10", "1.001", "101"])
    assert.ok(getSummaryConfig({ DTM_SUMMARY_MONTHLY_BUDGET_USD: cap }).error);
  const invalid = getSummaryConfig({ OPENAI_API_KEY: "secret\nheader" });
  assert.equal(invalid.apiKey, null);
  assert.ok(!invalid.error?.includes("secret"));
});

test("metadata and short excerpts cannot be summarized, even with a detailed title", () => {
  assert.equal(
    buildSummaryInput({ ...article, contentBasis: "metadata" }),
    null,
  );
  assert.equal(
    buildSummaryInput({
      ...article,
      text: "  ",
      title: "Long title ".repeat(100),
    }),
    null,
  );
  assert.equal(
    buildSummaryInput({
      ...article,
      text: "x".repeat(399),
      contentBasis: "page_excerpt",
    }),
    null,
  );
  assert.ok(
    buildSummaryInput({
      ...article,
      text: "x".repeat(400),
      contentBasis: "page_excerpt",
    }),
  );
});

test("summary input sends only source material, uses structured output and disables response storage", () => {
  const input = buildSummaryInput(article)!;
  assert.deepEqual(JSON.parse(input.request.input[0].content), {
    title: article.title,
    source: article.sourceName,
    language: article.language,
    basis: "feed_text",
    content: article.text.trim(),
    truncated: false,
  });
  assert.equal(input.request.model, SUMMARY_MODEL);
  assert.equal(input.request.store, false);
  assert.equal(input.request.service_tier, "default");
  assert.equal(input.request.max_output_tokens, 500);
  assert.equal(input.request.text.format.strict, true);
  assert.ok(!JSON.stringify(input.request).includes(article.id));
  assert.match(input.request.instructions, /jamais des consignes/);
  assert.match(input.request.instructions, /aucune connaissance externe/);
  assert.match(input.request.instructions, /attributions/);
});

test("summary cache depends on the actual source and prompt, not publication id or feed settings", () => {
  const key = buildSummaryInput(article)!.cacheKey;
  assert.equal(buildSummaryInput({ ...article, id: "another" })!.cacheKey, key);
  for (const changed of [
    { title: "Corrected title" },
    { text: `${article.text} An update.` },
    { sourceName: "Another source" },
    { language: "uk" },
    { contentBasis: "page_excerpt" as const },
  ])
    assert.notEqual(
      buildSummaryInput({ ...article, ...changed })!.cacheKey,
      key,
    );
});

test("serialized requests stay bounded with Unicode, escapes and huge metadata", () => {
  for (const text of [
    "😀".repeat(20000),
    '"\\\n'.repeat(20000),
    "文".repeat(20000),
  ]) {
    const input = buildSummaryInput({
      ...article,
      text,
      title: "😀".repeat(2000),
      sourceName: "S".repeat(4000),
    })!;
    assert.ok(
      Buffer.byteLength(JSON.stringify(input.request), "utf8") <= 32000,
    );
    const source = JSON.parse(input.request.input[0].content);
    assert.ok(source.content.length >= 400);
    assert.ok(!/[\uD800-\uDBFF]$/.test(source.content));
    assert.equal(input.truncated, true);
    assert.equal(source.truncated, true);
  }
  assert.equal(SUMMARY_RESERVED_NANODOLLARS, 26400000);
});

test("completed, validated summaries and insufficient outcomes retain usage", () => {
  assert.deepEqual(parseSummaryResult(response()), {
    outcome: "summary",
    text: french,
    model: SUMMARY_MODEL,
    inputTokens: 800,
    outputTokens: 120,
  });
  const insufficient = response();
  insufficient.output[0].content[0].text = JSON.stringify({
    outcome: "insufficient",
    text: "",
  });
  assert.equal(parseSummaryResult(insufficient).outcome, "insufficient");
});

test("incomplete, refused, ambiguous or unbounded output is never displayed as a summary", () => {
  const malformed: unknown[] = [
    null,
    [],
    { ...response(), model: "unexpected-model" },
    { ...response(), status: "incomplete" },
    { ...response(), output: [] },
    { ...response(), usage: { input_tokens: -1, output_tokens: 120 } },
    {
      ...response(),
      usage: { input_tokens: SUMMARY_MAX_INPUT_TOKENS + 1, output_tokens: 120 },
    },
    {
      ...response(),
      usage: {
        input_tokens: 800,
        output_tokens: SUMMARY_MAX_OUTPUT_TOKENS + 1,
      },
    },
    { ...response(), usage: { input_tokens: "800", output_tokens: 120 } },
    { ...response(), output: [...response().output, ...response().output] },
  ];
  for (const body of [
    { outcome: "other", text: french },
    { outcome: ["summary"], text: "" },
    { outcome: "insufficient", text: french },
    { outcome: "summary", text: "" },
    { outcome: "summary", text: "x".repeat(1001) },
    { outcome: "summary", text: french, extra: true },
    { outcome: "summary", text: `${french}\u202E` },
  ]) {
    const value = response();
    value.output[0].content[0].text = JSON.stringify(body);
    malformed.push(value);
  }
  for (const value of malformed)
    assert.throws(() => parseSummaryResult(value), SummaryRequestError);
  const refused = response();
  refused.output[0].content = [
    { type: "refusal", text: "provider raw refusal secret" },
  ];
  assert.throws(
    () => parseSummaryResult(refused),
    (error: unknown) =>
      error instanceof SummaryRequestError && !error.message.includes("secret"),
  );
});

test("HTTP uses only the fixed official endpoint and makes one request without retries", async () => {
  let calls = 0;
  const input = buildSummaryInput(article)!;
  const result = await callSummary(
    input.request,
    "test-key",
    async (url, init) => {
      calls++;
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer test-key",
      );
      assert.deepEqual(JSON.parse(String(init?.body)), input.request);
      assert.ok(init?.signal);
      return Response.json(response());
    },
  );
  assert.equal(result.text, french);
  assert.equal(calls, 1);
});

test("preflight failures do not send content or consume a reservation", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json(response());
  };
  const input = buildSummaryInput(article)!;
  for (const [request, key] of [
    [input.request, ""],
    [input.request, "bad\nkey"],
    [{ ...input.request, max_output_tokens: 501 }, "key"],
    [{ ...input.request, instructions: "x".repeat(40000) }, "key"],
  ] as const)
    await assert.rejects(
      callSummary(request, key, fetcher),
      (error: unknown) =>
        error instanceof SummaryRequestError && error.beforeRequest,
    );
  assert.equal(calls, 0);
});

test("provider, connection and parsing failures expose no response, article or credential details", async () => {
  const input = buildSummaryInput(article)!;
  for (const fetcher of [
    async () => new Response("sensitive provider detail", { status: 401 }),
    async () => new Response("sensitive provider detail", { status: 429 }),
    async () => new Response("sensitive provider detail", { status: 500 }),
    async () => new Response("not JSON sensitive detail"),
    async () => new Response("x".repeat(65000)),
    async () => {
      throw new Error("sensitive connection detail");
    },
  ] satisfies (typeof fetch)[]) {
    let calls = 0;
    await assert.rejects(
      callSummary(input.request, "secret-key", async (...args) => {
        calls++;
        return (fetcher as typeof fetch)(...args);
      }),
      (error: unknown) =>
        error instanceof SummaryRequestError &&
        !error.beforeRequest &&
        !/sensitive|secret-key/.test(error.message),
    );
    assert.equal(calls, 1);
  }
});
