import assert from "node:assert/strict";
import test from "node:test";
import {
  MonitorSyncGate,
  selectionSnapshotKey,
} from "../src/components/monitor-sync";
import type { Article, Snapshot } from "../src/lib/types";

test("a delayed poll cannot overwrite a successful mutation, even after the write lock is released", () => {
  const gate = new MonitorSyncGate();
  let visible = "initial";
  const read = gate.beginRead()!;
  const write = gate.beginWrite()!;
  visible = "saved";
  gate.finishWrite(write);
  if (gate.acceptsRead(read)) visible = "stale poll";
  assert.equal(visible, "saved");
  gate.finishRead(read);
  const fresh = gate.beginRead()!;
  assert.equal(gate.acceptsRead(fresh), true);
});

test("same-tick actions cannot both claim the write lock and no polling starts during a preview", () => {
  const gate = new MonitorSyncGate();
  const preview = gate.beginWrite();
  assert.notEqual(preview, null);
  assert.equal(gate.beginWrite(), null);
  assert.equal(gate.beginRead(), null);
  gate.finishWrite(preview!);
  assert.notEqual(gate.beginRead(), null);
});

test("finishing a cancelled poll cannot unlock or invalidate a newer request", () => {
  const gate = new MonitorSyncGate();
  const old = gate.beginRead()!;
  gate.cancelRead();
  const fresh = gate.beginRead()!;
  gate.finishRead(old);
  assert.equal(gate.acceptsRead(old), false);
  assert.equal(gate.acceptsRead(fresh), true);
  assert.equal(gate.beginRead(), null);
});

test("a stale write completion cannot release a later action's lock", () => {
  const gate = new MonitorSyncGate();
  const old = gate.beginWrite()!;
  gate.finishWrite(old);
  const fresh = gate.beginWrite()!;
  gate.finishWrite(old);
  assert.equal(gate.beginRead(), null);
  assert.equal(gate.beginWrite(), null);
  gate.finishWrite(fresh);
  assert.notEqual(gate.beginRead(), null);
});

test("visibility cancellation rejects a read even if its network response arrives later", () => {
  const gate = new MonitorSyncGate();
  const read = gate.beginRead()!;
  gate.cancelRead();
  assert.equal(gate.acceptsRead(read), false);
  const returning = gate.beginRead()!;
  assert.equal(gate.acceptsRead(returning), true);
});

test("scheduler activity alone preserves a profile preview while publications, revisions and feedback invalidate it", () => {
  const article: Article = {
    id: "fixture",
    sourceId: "source",
    sourceName: "Fixture",
    title: "Synthetic article",
    url: "https://example.test/article",
    publishedAt: "2026-01-01",
    collectedAt: "2026-01-01T12:00:00.000Z",
    updatedAt: null,
    revision: 1,
    changeKind: null,
    language: "en",
    format: "article",
    themes: [],
    excerpt: null,
    contentBasis: "metadata",
    score: 0,
    reasons: [],
    isRead: false,
    saved: false,
    feedback: null,
    keepSeparate: false,
    folderIds: [],
  };
  const snapshot: Pick<Snapshot, "articles" | "profile" | "collection"> = {
    articles: [article],
    profile: { keywords: ["drone"], excludeKeywords: [], minScore: 1 },
    collection: {
      enabled: false,
      intervalMinutes: 60,
      nextRunAt: null,
      running: false,
      lastRun: null,
    },
  };
  const initial = selectionSnapshotKey(snapshot);
  const scheduled = {
    ...snapshot,
    collection: {
      ...snapshot.collection,
      enabled: true,
      nextRunAt: "2026-01-02T12:00:00.000Z",
    },
  };
  assert.equal(selectionSnapshotKey(scheduled), initial);
  assert.equal(selectionSnapshotKey(structuredClone(snapshot)), initial);
  assert.equal(
    selectionSnapshotKey({
      ...snapshot,
      articles: [
        {
          ...article,
          summary: {
            status: "ready",
            canGenerate: false,
            reason: null,
            text: "Résumé en français de la publication.",
          },
        },
      ],
    }),
    initial,
  );
  assert.equal(
    selectionSnapshotKey({
      ...snapshot,
      articles: [
        {
          ...article,
          jev: {
            score: 3,
            confidence: 0.9,
            kind: "technical",
            kindConfidence: 0.9,
            model: "jev-1.13.0",
            evaluatedAt: "2026-09-25T00:00:00Z",
            applied: true,
            scope: "all_text",
            truncated: false,
          },
        },
      ],
    }),
    initial,
  );
  for (const change of [
    { articles: [...snapshot.articles, { ...article, id: "second" }] },
    { articles: [{ ...article, revision: 2 }] },
    { articles: [{ ...article, feedback: "relevant" as const }] },
    { profile: { ...snapshot.profile, minScore: 2 } },
  ])
    assert.notEqual(selectionSnapshotKey({ ...snapshot, ...change }), initial);
});
