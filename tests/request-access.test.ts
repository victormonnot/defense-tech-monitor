import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/monitor/route";
import {
  assertRequestAccess,
  assertRequestOrigin,
  RequestAccessError,
  type RequestAccessEnvironment,
} from "../src/lib/request-access";
import { MonitorStore } from "../src/lib/store";
import { proxy } from "../src/proxy";

const origin = "https://monitor.example.test";
const secret = "a1".repeat(32);
const hosted = { DTM_APP_ORIGIN: origin, DTM_PROXY_SECRET: secret };

function request(headers: Record<string, string> = {}, path = "/") {
  return new NextRequest(`http://127.0.0.1:3000${path}`, { headers });
}

function denied(run: () => unknown, status = 403) {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof RequestAccessError && error.status === status,
  );
}

async function withEnvironment(
  environment: RequestAccessEnvironment,
  run: () => Promise<void> | void,
) {
  const previous = {
    DTM_APP_ORIGIN: process.env.DTM_APP_ORIGIN,
    DTM_PROXY_SECRET: process.env.DTM_PROXY_SECRET,
  };
  for (const key of ["DTM_APP_ORIGIN", "DTM_PROXY_SECRET"] as const) {
    if (environment[key] === undefined) delete process.env[key];
    else process.env[key] = environment[key];
  }
  try {
    await run();
  } finally {
    for (const key of ["DTM_APP_ORIGIN", "DTM_PROXY_SECRET"] as const) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("local access accepts only canonical loopback hosts and ignores forwarded headers", () => {
  for (const host of ["127.0.0.1:3000", "localhost", "[::1]:3000"]) {
    assert.deepEqual(assertRequestAccess(request({ host }), {}), {
      mode: "local",
      origin: `http://${host}`,
    });
  }
  for (const host of [
    "monitor.example.test",
    "127.0.0.2",
    "localhost.example.test",
    "127.0.0.1@evil.example",
    "localhost/path",
    "localhost:invalid",
    "",
  ]) {
    denied(() =>
      assertRequestAccess(
        request({
          host,
          "x-forwarded-host": "localhost",
          forwarded: "host=localhost;proto=http",
        }),
        {},
      ),
    );
  }
  denied(() => assertRequestAccess(request(), {}));
});

test("hosted access requires the configured Host and exact trusted proxy secret", () => {
  const valid = { host: "monitor.example.test", "x-dtm-proxy-secret": secret };
  assert.deepEqual(assertRequestAccess(request(valid), hosted), {
    mode: "hosted",
    origin,
  });
  for (const supplied of ["", "b2".repeat(32), secret.slice(1), `${secret}0`])
    denied(() =>
      assertRequestAccess(
        request({ ...valid, "x-dtm-proxy-secret": supplied }),
        hosted,
      ),
    );
  denied(() =>
    assertRequestAccess(request({ host: "monitor.example.test" }), hosted),
  );
  for (const host of ["127.0.0.1:3000", "other.example.test", ""]) {
    denied(() =>
      assertRequestAccess(
        request({
          ...valid,
          host,
          "x-forwarded-host": "monitor.example.test",
          "x-forwarded-proto": "https",
        }),
        hosted,
      ),
    );
  }
});

test("partial, empty or noncanonical hosted configuration fails closed", () => {
  const invalid: RequestAccessEnvironment[] = [
    { DTM_APP_ORIGIN: "", DTM_PROXY_SECRET: "" },
    { DTM_APP_ORIGIN: origin },
    { DTM_PROXY_SECRET: secret },
    { ...hosted, DTM_PROXY_SECRET: "" },
    { ...hosted, DTM_PROXY_SECRET: "z".repeat(64) },
    { ...hosted, DTM_PROXY_SECRET: "a".repeat(63) },
    ...[
      "",
      "not-a-url",
      "http://monitor.example.test",
      `${origin}/`,
      `${origin}/dashboard`,
      `${origin}?q=1`,
      `${origin}#fragment`,
      "https://user:password@monitor.example.test",
      "https://MONITOR.example.test",
      "https://monitor.example.test:443",
    ].map((value) => ({ ...hosted, DTM_APP_ORIGIN: value })),
  ];
  for (const configuration of invalid)
    denied(
      () => assertRequestAccess(request({ host: "localhost" }), configuration),
      503,
    );
});

test("mutations require the exact local or hosted origin and reject cross-site requests", () => {
  for (const context of [
    { mode: "local" as const, origin: "http://127.0.0.1:3000" },
    { mode: "hosted" as const, origin },
  ]) {
    assertRequestOrigin(request({ origin: context.origin }), context, true);
    assertRequestOrigin(request(), context);
    for (const supplied of [
      "null",
      `${context.origin}/`,
      "https://evil.example",
      context.origin.replace(/^https?:/, (protocol) =>
        protocol === "http:" ? "https:" : "http:",
      ),
    ])
      denied(() =>
        assertRequestOrigin(request({ origin: supplied }), context, true),
      );
    denied(() => assertRequestOrigin(request(), context, true));
    denied(() =>
      assertRequestOrigin(request({ origin: "https://evil.example" }), context),
    );
    denied(() =>
      assertRequestOrigin(
        request({ origin: context.origin, "sec-fetch-site": "cross-site" }),
        context,
        true,
      ),
    );
  }
});

test("proxy guards page, API and static requests without returning secrets", async () => {
  await withEnvironment(hosted, async () => {
    for (const path of [
      "/",
      "/api/monitor",
      "/_next/static/app.js",
      "/favicon.svg",
    ]) {
      const blocked = proxy(request({ host: "monitor.example.test" }, path));
      assert.equal(blocked.status, 403);
      assert.equal(blocked.headers.get("cache-control"), "private, no-store");
      assert.ok(!(await blocked.text()).includes(secret));
      const allowed = proxy(
        request(
          { host: "monitor.example.test", "x-dtm-proxy-secret": secret },
          path,
        ),
      );
      assert.equal(allowed.headers.get("x-middleware-next"), "1");
    }
  });
  await withEnvironment({ DTM_APP_ORIGIN: origin }, () => {
    assert.equal(proxy(request({ host: "localhost" })).status, 503);
  });
});

test("API denies direct access before touching storage or reading a mutation body", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "monitorStore",
  );
  let reads = 0;
  Object.defineProperty(globalThis, "monitorStore", {
    configurable: true,
    get() {
      reads++;
      throw new Error("Unauthorized storage access");
    },
  });
  t.after(() => {
    if (descriptor)
      Object.defineProperty(globalThis, "monitorStore", descriptor);
    else Reflect.deleteProperty(globalThis, "monitorStore");
  });
  await withEnvironment(hosted, async () => {
    const headers = {
      host: "monitor.example.test",
      origin,
      "content-type": "application/json",
      "x-middleware-subrequest": "proxy:proxy:proxy:proxy:proxy",
    };
    assert.equal((await GET(request(headers, "/api/monitor"))).status, 403);
    const mutation = new NextRequest("http://127.0.0.1:3000/api/monitor", {
      method: "POST",
      headers,
      body: "{",
    });
    mutation.text = async () => {
      throw new Error("Unauthorized request body read");
    };
    assert.equal((await POST(mutation)).status, 403);
  });
  await withEnvironment({ DTM_APP_ORIGIN: origin }, async () => {
    assert.equal((await GET(request({ host: "localhost" }))).status, 503);
    assert.equal((await POST(request({ host: "localhost" }))).status, 503);
  });
  assert.equal(reads, 0);
});

test("authenticated hosted API supports reads and previews without changing data or calling providers", async (t) => {
  const store = new MonitorStore(":memory:", false);
  const globals = globalThis as typeof globalThis & {
    monitorStore?: MonitorStore;
  };
  const previous = globals.monitorStore;
  const previousFetch = globalThis.fetch;
  globals.monitorStore = store;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("Unexpected provider request");
  };
  t.after(() => {
    globals.monitorStore = previous;
    globalThis.fetch = previousFetch;
    store.db.close();
  });
  await withEnvironment(hosted, async () => {
    const headers = {
      host: "monitor.example.test",
      "x-dtm-proxy-secret": secret,
    };
    const before = store.db
      .prepare("SELECT total_changes() AS count")
      .get()?.count;
    const read = await GET(request(headers, "/api/monitor"));
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("cache-control"), "no-store");
    assert.ok(!(await read.text()).includes(secret));
    async function preview(suppliedOrigin: string) {
      return POST(
        new NextRequest("http://127.0.0.1:3000/api/monitor", {
          method: "POST",
          headers: {
            ...headers,
            origin: suppliedOrigin,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            action: "previewProfile",
            profile: store.profile(),
          }),
        }),
      );
    }
    assert.equal((await preview(origin)).status, 200);
    assert.equal((await preview("http://monitor.example.test")).status, 403);
    assert.equal(
      store.db.prepare("SELECT total_changes() AS count").get()?.count,
      before,
    );
    assert.equal(calls, 0);
  });
});
