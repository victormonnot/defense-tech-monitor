import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorStore } from "../src/lib/store";
import {
  reserveXRequest,
  settleXRequest,
  xConfig,
  xSnapshot,
} from "../src/lib/x-store";

const now = Date.parse("2026-09-28T10:00:00Z");
const config = {
  apiKey: "synthetic-secret",
  monthlyBudgetUsd: 0.1,
  error: null,
};

test("X budget persists reservations across connections, failures and restart", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-x-budget-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "monitor.sqlite");
  const a = new MonitorStore(path, false);
  const b = new MonitorStore(path, false);
  const lookup = reserveXRequest(a.db, "user", config, now);
  settleXRequest(a.db, lookup, 1, now);
  const first = reserveXRequest(a.db, "posts", config, now);
  assert.equal(first.count, 10);
  const second = reserveXRequest(b.db, "posts", config, now);
  assert.equal(second.count, 8);
  assert.throws(() => reserveXRequest(a.db, "posts", config, now), /budget X/);
  settleXRequest(b.db, second, null, now);
  assert.equal(xSnapshot(a.db, config, now).spentUsd, 0.1);
  assert.ok(
    !JSON.stringify(xSnapshot(a.db, config, now)).includes(config.apiKey),
  );
  a.db.close();
  b.db.close();
  const reopened = new MonitorStore(path, false);
  t.after(() => reopened.db.close());
  assert.equal(xSnapshot(reopened.db, config, now).remainingUsd, 0);
  // A late successful response can settle a reservation only once.
  settleXRequest(reopened.db, first, 2, now);
  settleXRequest(reopened.db, first, 0, now);
  assert.equal(xSnapshot(reopened.db, config, now).spentUsd, 0.06);
  assert.equal(
    xSnapshot(reopened.db, config, Date.parse("2026-10-01T00:00:00Z")).spentUsd,
    0,
  );
});

test("X refuses disabled configuration and a budget smaller than the API minimum page", (t) => {
  const store = new MonitorStore(":memory:", false);
  t.after(() => store.db.close());
  for (const disabled of [
    { ...config, apiKey: "" },
    { ...config, monthlyBudgetUsd: 0 },
    { ...config, error: "Invalid cap" },
  ])
    assert.throws(() => reserveXRequest(store.db, "posts", disabled, now));
  assert.throws(
    () =>
      reserveXRequest(
        store.db,
        "posts",
        { ...config, monthlyBudgetUsd: 0.024 },
        now,
      ),
    /budget X/,
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM x_requests").get()!.n,
    0,
  );
});

test("X environment validation fails closed without exposing credential values", (t) => {
  const key = process.env.X_BEARER_TOKEN;
  const cap = process.env.DTM_X_MONTHLY_BUDGET_USD;
  t.after(() => {
    if (key === undefined) delete process.env.X_BEARER_TOKEN;
    else process.env.X_BEARER_TOKEN = key;
    if (cap === undefined) delete process.env.DTM_X_MONTHLY_BUDGET_USD;
    else process.env.DTM_X_MONTHLY_BUDGET_USD = cap;
  });
  process.env.X_BEARER_TOKEN = "secret-never-returned";
  for (const invalid of ["NaN", "-1", "Infinity", "1001", "oops-secret"]) {
    process.env.DTM_X_MONTHLY_BUDGET_USD = invalid;
    assert.equal(xConfig().monthlyBudgetUsd, 0);
    assert.ok(xConfig().error);
    assert.ok(!xConfig().error!.includes(invalid));
  }
  delete process.env.DTM_X_MONTHLY_BUDGET_USD;
  assert.equal(xConfig().monthlyBudgetUsd, 0);
  assert.ok(xConfig().error);
});

test("version 10 migration preserves all existing tables and adds empty X state", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dtm-x-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "monitor.sqlite");
  const store = new MonitorStore(path);
  store.db.exec(
    "DROP TABLE x_requests; DROP TABLE x_sources; PRAGMA user_version=10;",
  );
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => String(r.name));
  const before = tables.map((name) =>
    store.db.prepare(`SELECT * FROM ${name}`).all(),
  );
  store.db.close();
  const upgraded = new MonitorStore(path);
  t.after(() => upgraded.db.close());
  assert.equal(
    upgraded.db.prepare("PRAGMA user_version").get()!.user_version,
    11,
  );
  assert.deepEqual(
    tables.map((name) => upgraded.db.prepare(`SELECT * FROM ${name}`).all()),
    before,
  );
  assert.equal(
    upgraded.db.prepare("PRAGMA integrity_check").get()!.integrity_check,
    "ok",
  );
  assert.deepEqual(upgraded.db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(xSnapshot(upgraded.db).spentUsd, 0);
});
