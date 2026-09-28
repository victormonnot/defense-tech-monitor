import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  GET as getPrivate,
  POST as postPrivate,
} from "../src/app/api/monitor/route";
import { GET as getPublic } from "../src/app/api/public-monitor/route";
import {
  assertAdminRequest,
  assertRequestAccess,
  isPublicReadOnlyEnabled,
  RequestAccessError,
  type RequestAccessEnvironment,
} from "../src/lib/request-access";
import { publicSnapshot } from "../src/lib/public-monitor";
import { MonitorStore } from "../src/lib/store";
import type { Article, Snapshot, Source } from "../src/lib/types";
import { proxy } from "../src/proxy";

const origin = "https://monitor.example.test";
const secret = "a1".repeat(32);
const hosted = {
  DTM_APP_ORIGIN: origin,
  DTM_PROXY_SECRET: secret,
  DTM_PUBLIC_READ_ONLY: "1",
};
const environmentKeys = [
  "DTM_APP_ORIGIN",
  "DTM_PROXY_SECRET",
  "DTM_PUBLIC_READ_ONLY",
] as const;

async function withEnvironment(
  environment: RequestAccessEnvironment,
  run: () => void | Promise<void>,
) {
  const previous = environmentKeys.map((key) => process.env[key]);
  for (const key of environmentKeys) {
    if (environment[key] === undefined) delete process.env[key];
    else process.env[key] = environment[key];
  }
  try {
    await run();
  } finally {
    for (const [index, key] of environmentKeys.entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function request(
  path = "/",
  role: string | null = "public",
  method = "GET",
  overrides: Record<string, string> = {},
) {
  return new NextRequest(`http://127.0.0.1:3000${path}`, {
    method,
    headers: {
      host: "monitor.example.test",
      "x-dtm-proxy-secret": secret,
      ...(role === null ? {} : { "x-dtm-access": role }),
      ...overrides,
    },
  });
}

function denied(run: () => unknown, status = 403) {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof RequestAccessError && error.status === status,
  );
}

test("public deployment requires valid configuration and an exact trusted gateway role", () => {
  assert.equal(isPublicReadOnlyEnabled({}), false);
  assert.equal(isPublicReadOnlyEnabled({ DTM_PUBLIC_READ_ONLY: "0" }), false);
  assert.equal(isPublicReadOnlyEnabled(hosted), true);
  for (const role of ["public", "admin"])
    assert.deepEqual(assertRequestAccess(request("/", role), hosted), {
      mode: "hosted",
      origin,
      role,
    });
  for (const role of [null, "", "Admin", "PUBLIC", "public, admin", "owner"])
    denied(() => assertRequestAccess(request("/", role), hosted));
  denied(() =>
    assertRequestAccess(
      request("/", "admin", "GET", { "x-dtm-proxy-secret": "forged" }),
      hosted,
    ),
  );
  for (const configuration of [
    { DTM_PUBLIC_READ_ONLY: "1" },
    { ...hosted, DTM_APP_ORIGIN: undefined },
    { ...hosted, DTM_PROXY_SECRET: undefined },
    ...["", "true", "false", "2", " 1"].map((value) => ({
      ...hosted,
      DTM_PUBLIC_READ_ONLY: value,
    })),
  ])
    denied(() => assertRequestAccess(request(), configuration), 503);
  // The old local/private gateway sends no role. A new role with the old
  // deployment mode is a configuration mismatch, never private-page access.
  assert.deepEqual(
    assertRequestAccess(request("/", null, "GET", { host: "localhost" }), {}),
    { mode: "local", origin: "http://localhost" },
  );
  for (const mode of [undefined, "0"])
    for (const role of ["public", "admin"])
      denied(
        () =>
          assertRequestAccess(request("/", role), {
            ...hosted,
            DTM_PUBLIC_READ_ONLY: mode,
          }),
        503,
      );
});

test("proxy exposes only public reads while protecting management and all other API paths", async () => {
  await withEnvironment(hosted, () => {
    for (const [path, method] of [
      ["/", "GET"],
      ["/_next/static/app.js", "GET"],
      ["/api/public-monitor", "GET"],
      ["/api/public-monitor", "HEAD"],
    ])
      assert.equal(
        proxy(request(path, "public", method)).headers.get("x-middleware-next"),
        "1",
      );
    for (const [path, method] of [
      ["/admin", "GET"],
      ["/admin/", "GET"],
      ["/admin/settings", "GET"],
      ["/%61dmin", "GET"],
      ["/api", "GET"],
      ["/api/monitor", "GET"],
      ["/api/monitor", "HEAD"],
      ["/api/monitor", "POST"],
      ["/api/future-route", "GET"],
      ["/api/public-monitor", "POST"],
      ["/api/public-monitor", "OPTIONS"],
      ["/api/public-monitor/other", "GET"],
    ]) {
      assert.equal(proxy(request(path, "public", method)).status, 403);
      assert.equal(
        proxy(request(path, "admin", method)).headers.get("x-middleware-next"),
        "1",
      );
    }
    denied(() => assertAdminRequest(request("/admin", "public")));
    assert.equal(assertAdminRequest(request("/admin", "admin")).role, "admin");
  });
});

test("private API and unauthenticated public reads fail before body or storage access", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "monitorStore",
  );
  let reads = 0;
  Object.defineProperty(globalThis, "monitorStore", {
    configurable: true,
    get() {
      reads++;
      throw new Error("Private storage touched before authorization");
    },
  });
  t.after(() => {
    if (descriptor)
      Object.defineProperty(globalThis, "monitorStore", descriptor);
    else Reflect.deleteProperty(globalThis, "monitorStore");
  });
  await withEnvironment(hosted, async () => {
    for (const role of ["public", null, "admin, public"])
      assert.equal(
        (await getPrivate(request("/api/monitor", role))).status,
        403,
      );
    const mutation = request("/api/monitor", "public", "POST", {
      origin,
      "content-type": "application/json",
      "x-middleware-subrequest": "proxy:proxy:proxy:proxy:proxy",
    });
    mutation.text = async () => {
      throw new Error("Public mutation body must not be read");
    };
    assert.equal((await postPrivate(mutation)).status, 403);
    for (const role of [null, "Admin", "public, admin"])
      assert.equal(getPublic(request("/api/public-monitor", role)).status, 403);
    assert.equal(
      getPublic(
        request("/api/public-monitor", "admin", "GET", {
          "x-dtm-proxy-secret": "forged",
        }),
      ).status,
      403,
    );
    assert.equal(
      getPublic(
        request("/api/public-monitor", "public", "GET", {
          origin: "https://other.example.test",
        }),
      ).status,
      403,
    );
  });
  await withEnvironment({ ...hosted, DTM_PUBLIC_READ_ONLY: "" }, async () => {
    assert.equal(
      (await getPrivate(request("/api/monitor", "admin"))).status,
      503,
    );
    assert.equal(
      (await postPrivate(request("/api/monitor", "admin"))).status,
      503,
    );
    assert.equal(getPublic(request("/api/public-monitor")).status, 503);
  });
  for (const mode of [undefined, "0"])
    await withEnvironment(
      { ...hosted, DTM_PUBLIC_READ_ONLY: mode },
      async () => {
        for (const role of ["public", "admin"]) {
          assert.equal(proxy(request("/", role)).status, 503);
          denied(() => assertAdminRequest(request("/", role)), 503);
          assert.equal(
            (await getPrivate(request("/api/monitor", role))).status,
            503,
          );
          assert.equal(
            (await postPrivate(request("/api/monitor", role))).status,
            503,
          );
          assert.equal(
            getPublic(request("/api/public-monitor", role)).status,
            503,
          );
        }
      },
    );
  assert.equal(reads, 0);
});

test("public projection explicitly excludes personal fields and unsafe links", () => {
  const source: Source = {
    id: "source",
    name: "Public source",
    siteUrl: "https://example.test/",
    feedUrl: "https://example.test/private-feed?token=PRIVATE_SENTINEL",
    collectionKind: "rss",
    collectionUrl: "PRIVATE_SENTINEL",
    language: "en",
    enabled: true,
    status: "error",
    lastCheckedAt: null,
    lastSuccessAt: null,
    lastError: "PRIVATE_SENTINEL",
    articleCount: 1,
  };
  const article: Article = {
    id: "article",
    sourceId: source.id,
    sourceName: source.name,
    title: "Public title",
    url: "https://example.test/article",
    publishedAt: null,
    collectedAt: "2026-09-28T12:00:00Z",
    updatedAt: null,
    language: "en",
    format: "article",
    excerpt: "Public excerpt",
    contentBasis: "page_text",
    revision: 3,
    changeKind: "new",
    themes: ["PRIVATE_SENTINEL"],
    score: 42,
    reasons: ["PRIVATE_SENTINEL"],
    isRead: true,
    saved: true,
    feedback: "relevant",
    keepSeparate: true,
    folderIds: ["PRIVATE_SENTINEL"],
    summary: {
      status: "ready",
      text: "Public cached summary",
      generatedAt: "2026-09-28T12:00:00Z",
      canGenerate: false,
      reason: "PRIVATE_SENTINEL",
      model: "PRIVATE_SENTINEL",
    },
  };
  const snapshot = {
    articles: [article],
    sources: [source, { ...source, id: "unused", name: "PRIVATE_SENTINEL" }],
    lastCollectionAt: "2026-09-28T12:00:00Z",
    folders: [{ id: "PRIVATE_SENTINEL", name: "PRIVATE_SENTINEL" }],
    profile: { keywords: ["PRIVATE_SENTINEL"] },
    customFeeds: [{ instructions: "PRIVATE_SENTINEL" }],
    jev: { configurationError: "PRIVATE_SENTINEL", monthlyBudgetUsd: 123 },
    summaries: { configurationError: "PRIVATE_SENTINEL" },
    x: { error: "PRIVATE_SENTINEL" },
    activity: { lastReviewedAt: "PRIVATE_SENTINEL" },
  } as unknown as Snapshot;
  const projected = publicSnapshot(snapshot);
  assert.deepEqual(Object.keys(projected).sort(), [
    "articles",
    "lastCollectionAt",
    "sources",
  ]);
  assert.deepEqual(Object.keys(projected.articles[0]).sort(), [
    "collectedAt",
    "contentBasis",
    "excerpt",
    "format",
    "id",
    "language",
    "publishedAt",
    "sourceId",
    "sourceName",
    "summary",
    "title",
    "updatedAt",
    "url",
  ]);
  assert.deepEqual(projected.sources, [
    { id: source.id, name: source.name, siteUrl: source.siteUrl },
  ]);
  assert.deepEqual(projected.articles[0].summary, {
    text: "Public cached summary",
    generatedAt: "2026-09-28T12:00:00Z",
  });
  assert.ok(!JSON.stringify(projected).includes("PRIVATE_SENTINEL"));
  for (const status of [
    "available",
    "insufficient",
    "pending",
    "failed",
  ] as const) {
    article.summary!.status = status;
    assert.equal(publicSnapshot(snapshot).articles[0].summary, undefined);
  }
  article.summary!.status = "ready";
  article.summary!.generatedAt = "invalid";
  assert.equal(publicSnapshot(snapshot).articles[0].summary, undefined);
  article.summary!.generatedAt = "2026-09-28T12:00:00Z";
  article.summary!.text = " ";
  assert.equal(publicSnapshot(snapshot).articles[0].summary, undefined);
  for (const unsafe of [
    "javascript:alert(1)",
    "data:text/html,private",
    "file:///private",
    "https://user:password@example.test/",
    "https://user@example.test/",
    "invalid",
  ]) {
    article.url = unsafe;
    assert.deepEqual(publicSnapshot(snapshot).articles, []);
    assert.deepEqual(publicSnapshot(snapshot).sources, []);
    article.url = "https://example.test/article";
    source.siteUrl = unsafe;
    assert.deepEqual(publicSnapshot(snapshot).sources, []);
  }
});

test("public GET reads an isolated database without writing or invoking any provider", async (t) => {
  const store = new MonitorStore(":memory:", false);
  const globals = globalThis as typeof globalThis & {
    monitorStore?: MonitorStore;
  };
  const previousStore = globals.monitorStore;
  const previousFetch = globalThis.fetch;
  globals.monitorStore = store;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("Public reads must never call a provider");
  };
  t.after(() => {
    globals.monitorStore = previousStore;
    globalThis.fetch = previousFetch;
    store.db.close();
  });
  const source = store.addSource({
    name: "Public source",
    siteUrl: "https://example.test/",
    feedUrl: "https://example.test/feed",
    language: "en",
  });
  store.upsertEntries(
    source,
    [
      {
        guid: "synthetic",
        url: "https://example.test/article",
        title: "Synthetic public publication",
        publishedAt: null,
        text: "Synthetic collected text",
        excerpt: "Synthetic public excerpt",
        language: "en",
        format: "article",
        contentHash: "synthetic",
      },
    ],
    "2026-09-28T12:00:00Z",
  );
  store.setProfile({
    keywords: ["PRIVATE_PROFILE_SENTINEL"],
    excludeKeywords: [],
    minScore: 0,
  });
  const changes = store.db
    .prepare("SELECT total_changes() AS count")
    .get()?.count;
  await withEnvironment(hosted, async () => {
    const response = getPublic(request("/api/public-monitor"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text();
    assert.ok(body.includes("Synthetic public publication"));
    assert.ok(!body.includes("PRIVATE_PROFILE_SENTINEL"));
    assert.ok(!body.includes(secret));
    assert.equal(
      (await getPrivate(request("/api/monitor", "admin"))).status,
      200,
    );
  });
  assert.equal(
    store.db.prepare("SELECT total_changes() AS count").get()?.count,
    changes,
  );
  assert.equal(calls, 0);
});
