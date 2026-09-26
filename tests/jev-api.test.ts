import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/monitor/route";
import { MonitorStore } from "../src/lib/store";

test("Jev API validates mode and origin, keeps GET free of paid work and never exposes its key", async (t) => {
  const store = new MonitorStore(":memory:", false);
  const globals = globalThis as typeof globalThis & {
    monitorStore?: MonitorStore;
  };
  const previous = globals.monitorStore;
  const previousKey = process.env.TYPESAFE_API_KEY;
  const previousCap = process.env.DTM_JEV_MONTHLY_BUDGET_USD;
  const previousFetch = globalThis.fetch;
  globals.monitorStore = store;
  delete process.env.TYPESAFE_API_KEY;
  process.env.DTM_JEV_MONTHLY_BUDGET_USD = "5";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("Unexpected paid request");
  };
  t.after(() => {
    globals.monitorStore = previous;
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
    if (previousCap === undefined)
      delete process.env.DTM_JEV_MONTHLY_BUDGET_USD;
    else process.env.DTM_JEV_MONTHLY_BUDGET_USD = previousCap;
    store.db.close();
  });
  const base = "http://127.0.0.1:3001";
  const get = () =>
    GET(
      new NextRequest(`${base}/api/monitor`, {
        headers: { host: "127.0.0.1:3001" },
      }),
    );
  const post = (body: unknown, origin = base) =>
    POST(
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
  assert.equal((await (await get()).json()).snapshot.jev.mode, "off");
  assert.equal(
    (await post({ action: "setJevMode", mode: "compare" })).status,
    400,
  );
  process.env.TYPESAFE_API_KEY = "synthetic-secret-never-expose";
  for (const mode of [null, "invalid", true, {}, 1])
    assert.equal((await post({ action: "setJevMode", mode })).status, 400);
  assert.equal(
    (
      await post(
        { action: "setJevMode", mode: "personal" },
        "https://external.example",
      )
    ).status,
    403,
  );
  for (const mode of ["compare", "personal", "off"]) {
    const result = await post({ action: "setJevMode", mode });
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.equal(body.snapshot.jev.mode, mode);
    assert.ok(!JSON.stringify(body).includes("synthetic-secret-never-expose"));
  }
  assert.equal(
    (await post({ action: "retryJevFailures" }, "https://external.example"))
      .status,
    403,
  );
  const before = store.db.prepare("SELECT * FROM settings ORDER BY key").all();
  await get();
  await get();
  assert.deepEqual(
    store.db.prepare("SELECT * FROM settings ORDER BY key").all(),
    before,
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM jev_attempts").get()?.count,
    0,
  );
  assert.equal(calls, 0);
});
