import assert from "node:assert/strict";
import test from "node:test";
import {
  activityOrder,
  matchesActivity,
  MAX_ACTIVITY_BATCH,
  parseActivityBatch,
  reviewBatch,
} from "../src/lib/activity";

test("activity filters distinguish first collection from later changes", () => {
  assert.equal(matchesActivity({ changeKind: null }, "all"), true);
  assert.equal(matchesActivity({ changeKind: "new" }, "new"), true);
  assert.equal(matchesActivity({ changeKind: "updated" }, "new"), false);
  assert.equal(matchesActivity({ changeKind: "new" }, "updated"), false);
  assert.equal(matchesActivity({ changeKind: null }, "updated"), false);
});

test("activity ordering follows collection changes, including timestamps with offsets", () => {
  const old = { collectedAt: "2026-01-01T12:00:00Z", updatedAt: null };
  const updated = { ...old, updatedAt: "2026-09-25T14:00:00+02:00" };
  const recent = { collectedAt: "2026-09-25T12:30:00Z", updatedAt: null };
  assert.deepEqual([old, recent, updated].sort(activityOrder), [
    recent,
    updated,
    old,
  ]);
});

test("catch-up captures only pending visible publications and their shown revision", () => {
  const visible = [
    { id: "already-reviewed", revision: 8, changeKind: null },
    { id: "new", revision: 3, changeKind: "new" as const },
    { id: "updated", revision: 2, changeKind: "updated" as const },
  ];
  const batch = reviewBatch(visible);
  visible[2].revision = 4;
  assert.deepEqual(batch, [
    { id: "new", revision: 3 },
    { id: "updated", revision: 2 },
  ]);
  assert.deepEqual(reviewBatch([]), []);
});

test("catch-up bounds each batch without including already reviewed articles", () => {
  const visible = Array.from({ length: 201 }, (_, i) => ({
    id: `visible-${i}`,
    revision: 1,
    changeKind: "new" as const,
  }));
  const batch = reviewBatch(visible);
  assert.equal(batch.length, MAX_ACTIVITY_BATCH);
  assert.equal(batch.at(-1)?.id, "visible-199");
});

test("API activity payload rejects malformed batches and unsafe revision values", () => {
  for (const value of [
    null,
    {},
    [],
    [null],
    [[]],
    ["article"],
    [{ id: "", revision: 1 }],
    [{ id: " a", revision: 1 }],
    [{ id: "x".repeat(201), revision: 1 }],
    [{ id: "a" }],
    ...[0, -1, 1.5, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(
      (revision) => [{ id: "a", revision }],
    ),
    Array.from({ length: 201 }, () => ({ id: "a", revision: 1 })),
  ])
    assert.throws(() => parseActivityBatch(value));
  assert.deepEqual(
    parseActivityBatch([{ id: "a", revision: 2, ignored: true }]),
    [{ id: "a", revision: 2 }],
  );
});
