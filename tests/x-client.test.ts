import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchXPosts,
  lookupXUser,
  parseXAccount,
  XApiError,
  type XFetch,
} from "../src/lib/x-client";

const apiKey = "private-test-token-not-for-output";
const post = {
  id: "1839000000000000001",
  text: "Un nouveau drone est présenté. https://t.co/example",
  created_at: "2026-09-28T10:30:00.000Z",
  lang: "fr",
};
const options = {
  userId: "1234567",
  username: "Example",
  apiKey,
  maxResults: 5,
};
const response = (data: unknown) => new Response(JSON.stringify(data));
const timeline = (data: unknown[] = [post], meta = {}) => ({
  data,
  meta: { result_count: data.length, ...meta },
});
const mockFetch =
  (payload: unknown): XFetch =>
  async () =>
    response(payload);

test("X account parsing normalizes handles and official profile links", () => {
  for (const input of [
    "@Example",
    "Example",
    " @Example ",
    "https://x.com/Example",
    "https://twitter.com/Example/",
    "https://www.x.com/Example?s=20#profile",
  ])
    assert.deepEqual(parseXAccount(input), {
      username: "example",
      url: "https://x.com/example",
    });
});

test("X account parsing rejects other resources, ambiguous URLs and spoof hosts", () => {
  for (const input of [
    "",
    "@@Example",
    "a-name",
    "a.name",
    "a".repeat(16),
    "https://x.com",
    "https://x.com/Example/status/123",
    "https://x.com/Example/followers",
    "https://x.com/i",
    "https://x.com/search?q=drones",
    "@home",
    "https://x.com/login",
    "https://x.com/intent",
    "http://x.com/Example",
    "https://x.com.evil.test/Example",
    "https://evilx.com/Example",
    "https://x.com@evil.test/Example",
    "https://name:secret@x.com/Example",
    "https://x.com:443/Example",
    "https://x.com:8443/Example",
    "https://x.com./Example",
    "https://x.com//Example",
    "https://x.com/a/../Example",
    "https://x.com/%45xample",
    "https://x.com/Example\\..\\other",
    "https://x.com/Exam\nple",
    "https://x.com/Example?bad=\nvalue",
  ])
    assert.equal(parseXAccount(input), null, input);
});

test("X lookup calls only the fixed official endpoint with bearer auth", async () => {
  let calls = 0;
  const user = await lookupXUser("Example", apiKey, async (input, init) => {
    calls += 1;
    assert.equal(
      String(input),
      "https://api.x.com/2/users/by/username/example",
    );
    assert.equal(init?.method, "GET");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${apiKey}`,
    );
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal);
    return response({ data: { id: "1234567", username: "Example" } });
  });
  assert.deepEqual(user, { id: "1234567", username: "example" });
  assert.equal(calls, 1);
});

test("X timeline requests bounded original posts and resumes both cursors", async () => {
  let calls = 0;
  const result = await fetchXPosts(
    { ...options, sinceId: "1839000000000000000", paginationToken: "page1" },
    async (input, init) => {
      calls += 1;
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.x.com");
      assert.equal(url.pathname, "/2/users/1234567/tweets");
      assert.equal(url.searchParams.get("max_results"), "5");
      assert.equal(url.searchParams.get("exclude"), "replies,retweets");
      assert.equal(
        url.searchParams.get("post.fields"),
        "created_at,lang,note_post",
      );
      assert.equal(url.searchParams.get("since_id"), "1839000000000000000");
      assert.equal(url.searchParams.get("pagination_token"), "page1");
      assert.equal(url.searchParams.has("expansions"), false);
      assert.equal(init?.redirect, "error");
      return response(
        timeline([post], { newest_id: post.id, next_token: "page2" }),
      );
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.resourceCount, 1);
  assert.equal(result.newestId, post.id);
  assert.equal(result.nextToken, "page2");
  assert.equal(
    result.entries[0].url,
    `https://x.com/example/status/${post.id}`,
  );
  assert.equal(result.entries[0].guid, post.id);
  assert.equal(result.entries[0].format, "post");
  assert.equal(result.entries[0].contentBasis, "feed_text");
  assert.equal(result.entries[0].title, post.text);
  assert.equal(result.entries[0].text, post.text);
  assert.equal(result.entries[0].publishedAt, post.created_at);
  assert.equal(result.entries[0].language, "fr");
});

test("X preserves long post text using current and legacy note fields", async () => {
  const text = `Une annonce avec <du texte>, des chiffres 12 et 25.\n${"Un complément 🛰️. ".repeat(80)}`;
  for (const field of ["note_post", "note_tweet"]) {
    const result = await fetchXPosts(
      options,
      mockFetch(timeline([{ ...post, [field]: { text } }])),
    );
    const entry = result.entries[0];
    assert.equal(entry.text, text.trim());
    assert.ok(entry.title.length <= 160);
    assert.ok(entry.excerpt!.length <= 480);
    assert.match(entry.title, /^Une annonce avec <du texte>/);
    assert.match(entry.title, /…$/);
  }
});

test("X preview hashes are stable and change when the actual content changes", async () => {
  const original = await fetchXPosts(options, mockFetch(timeline()));
  const again = await fetchXPosts(options, mockFetch(timeline()));
  const updated = await fetchXPosts(
    options,
    mockFetch(timeline([{ ...post, text: `${post.text} Mise à jour.` }])),
  );
  assert.equal(original.entries[0].contentHash, again.entries[0].contentHash);
  assert.notEqual(
    original.entries[0].contentHash,
    updated.entries[0].contentHash,
  );
  assert.match(original.entries[0].contentHash, /^[a-f0-9]{64}$/);
});

test("X keeps long-form text beyond the ordinary feed excerpt limit", async () => {
  const text = "Long-form reporting. ".repeat(1200);
  const result = await fetchXPosts(
    options,
    mockFetch(timeline([{ ...post, note_post: { text } }])),
  );
  assert.equal(result.entries[0].text, text.trim());
});

test("X accepts empty timelines without fabricating a cursor", async () => {
  for (const payload of [{ meta: { result_count: 0 } }, timeline([])]) {
    assert.deepEqual(await fetchXPosts(options, mockFetch(payload)), {
      entries: [],
      resourceCount: 0,
      newestId: null,
      nextToken: null,
    });
  }
});

test("X selects newest IDs without loss of integer precision", async () => {
  const result = await fetchXPosts(
    options,
    mockFetch(
      timeline([
        post,
        {
          ...post,
          id: "1839000000000000003",
          created_at: "2026-09-28T10:31:00Z",
        },
        { ...post, id: "1839000000000000002" },
      ]),
    ),
  );
  assert.equal(result.newestId, "1839000000000000003");
  assert.equal(result.entries[1].publishedAt, "2026-09-28T10:31:00.000Z");
});

test("X rejects invalid request parameters before any paid request", async () => {
  const fetcher: XFetch = async () => {
    assert.fail("No request should be sent");
  };
  for (const change of [
    { userId: "../users" },
    { userId: "0" },
    { userId: "9".repeat(20) },
    { username: "name/../../other" },
    { maxResults: 4 },
    { maxResults: 101 },
    { maxResults: 5.1 },
    { maxResults: NaN },
    { sinceId: "nan" },
    { paginationToken: "a b" },
    { paginationToken: "a".repeat(2049) },
    { apiKey: "" },
    { apiKey: "secret\nX-Fake: injected" },
  ]) {
    await assert.rejects(
      fetchXPosts({ ...options, ...change }, fetcher),
      (error: unknown) => {
        assert.ok(error instanceof XApiError);
        assert.equal(error.beforeRequest, true);
        return true;
      },
    );
  }
  await assert.rejects(
    lookupXUser("https://evil.test", apiKey, fetcher),
    XApiError,
  );
});

test("X rejects malformed users, including numeric or missing IDs", async () => {
  for (const payload of [
    {},
    { data: {} },
    { data: { id: 123, username: "example" } },
    { data: { id: "123", username: "../other" } },
    { data: { id: "123", username: "another" } },
    { data: { id: "123", username: "example" }, errors: [{ detail: apiKey }] },
  ]) {
    await assert.rejects(
      lookupXUser("example", apiKey, mockFetch(payload)),
      XApiError,
    );
  }
});

test("X rejects partial or malformed timelines instead of advancing the cursor", async () => {
  const invalidPosts = [
    { ...post, id: undefined },
    { ...post, id: 123 },
    { ...post, id: "NaN" },
    { ...post, text: undefined },
    { ...post, text: "  " },
    { ...post, created_at: undefined },
    { ...post, created_at: "not a date" },
    { ...post, created_at: "2026-02-30T10:00:00Z" },
    { ...post, lang: "../fr" },
    { ...post, note_post: { text: "" } },
    { ...post, note_post: { text: "a".repeat(100_001) } },
  ];
  const invalidPayloads = [
    null,
    [],
    {},
    { data: [post] },
    { data: [post], meta: {} },
    timeline([post], { result_count: 2 }),
    timeline([post], { result_count: "1" }),
    timeline([post], { newest_id: "1839000000000000005" }),
    timeline([post], { next_token: "bad token" }),
    timeline([], { next_token: "page2" }),
    timeline([post, post]),
    { ...timeline(), errors: [{ detail: apiKey }] },
    { ...timeline(), errors: "bad" },
    ...invalidPosts.map((value) => timeline([value])),
    timeline(
      Array.from({ length: 6 }, (_, index) => ({
        ...post,
        id: String(index + 1),
      })),
    ),
  ];
  for (const payload of invalidPayloads) {
    await assert.rejects(
      fetchXPosts(options, mockFetch(payload)),
      (error: unknown) => {
        assert.ok(error instanceof XApiError);
        assert.equal(error.message.includes(apiKey), false);
        return true;
      },
    );
  }
  await assert.rejects(
    fetchXPosts({ ...options, sinceId: post.id }, mockFetch(timeline())),
    XApiError,
  );
  await assert.rejects(
    fetchXPosts(
      { ...options, paginationToken: "page1" },
      mockFetch(timeline([post], { next_token: "page1" })),
    ),
    XApiError,
  );
});

test("X error handling never includes provider bodies or fetch exceptions", async () => {
  for (const status of [301, 401, 402, 403, 404, 429, 500]) {
    await assert.rejects(
      fetchXPosts(
        options,
        async () =>
          new Response(`Provider error containing ${apiKey}`, {
            status,
            headers: { "retry-after": "60" },
          }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof XApiError);
        assert.equal(error.status, status);
        assert.equal(error.retryAfter, 60);
        assert.equal(error.message.includes(apiKey), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
  for (const fetcher of [
    (async () => {
      throw new Error(`Request authorization ${apiKey}`);
    }) as XFetch,
    (async () => new Response(`broken JSON ${apiKey}`)) as XFetch,
  ]) {
    await assert.rejects(fetchXPosts(options, fetcher), (error: unknown) => {
      assert.ok(error instanceof XApiError);
      assert.equal(error.message.includes(apiKey), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("X enforces the response byte limit even without content-length", async () => {
  for (const oversized of [
    new Response("small", {
      headers: { "content-length": String(4 * 1024 * 1024 + 1) },
    }),
    new Response("a".repeat(4 * 1024 * 1024 + 1)),
  ])
    await assert.rejects(
      fetchXPosts(options, async () => oversized),
      XApiError,
    );
});

test("X prevents redirected successful responses from being treated as posts", async () => {
  const redirected = response(timeline());
  Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(
    fetchXPosts(options, async () => redirected),
    XApiError,
  );
});

test("X aborts a stalled request without exposing the underlying error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = fetchXPosts(options, async (_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          reject(new Error(`Connection failed with credential ${apiKey}`));
        },
        { once: true },
      );
    });
  });
  t.mock.timers.tick(15_000);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof XApiError);
    assert.equal(error.message, "X n’a pas répondu à temps.");
    assert.equal(error.beforeRequest, false);
    return true;
  });
});
