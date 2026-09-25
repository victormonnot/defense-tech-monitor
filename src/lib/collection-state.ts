import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CollectionResult, CollectionRun, CollectionState } from "./types";

export const COLLECTION_LEASE_MS = 10 * 60 * 1000;
export const COLLECTION_HEARTBEAT_MS = 30 * 1000;

type ScheduleRow = {
  enabled: number;
  interval_minutes: number;
  next_run_at: string | null;
};
type RunRow = {
  run_id: string;
  trigger: CollectionRun["trigger"];
  started_at: string;
  finished_at: string | null;
  status: CollectionRun["status"];
  result: string | null;
  error: string | null;
};

export class CollectionLeaseError extends Error {
  constructor() {
    super("La collecte a perdu son verrou et a été interrompue.");
  }
}

export function parseCollectionSchedule(
  enabled: unknown,
  intervalMinutes: unknown,
) {
  if (typeof enabled !== "boolean")
    throw new Error("État de collecte automatique invalide.");
  if (
    typeof intervalMinutes !== "number" ||
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < 15 ||
    intervalMinutes > 1440
  )
    throw new Error(
      "La fréquence doit être un nombre entier de 15 à 1 440 minutes.",
    );
  return { enabled, intervalMinutes };
}

function schedule(db: DatabaseSync): ScheduleRow {
  return db
    .prepare("SELECT * FROM collection_schedule WHERE id=1")
    .get() as ScheduleRow;
}

function run(db: DatabaseSync): RunRow | undefined {
  return db.prepare("SELECT * FROM collection_run WHERE id=1").get() as
    | RunRow
    | undefined;
}

function activeLease(db: DatabaseSync, id: string, now: number) {
  return !!db
    .prepare(
      "SELECT owner FROM collection_lock WHERE id=1 AND owner=? AND expires_at>?",
    )
    .get(id, new Date(now).toISOString());
}

export function collectionState(
  db: DatabaseSync,
  now = Date.now(),
): CollectionState {
  const current = schedule(db);
  const latest = run(db);
  const lastRun: CollectionRun | null = latest
    ? {
        id: latest.run_id,
        trigger: latest.trigger,
        startedAt: latest.started_at,
        finishedAt: latest.finished_at,
        status: latest.status,
        result: latest.result
          ? (JSON.parse(latest.result) as CollectionResult)
          : null,
        error: latest.error,
      }
    : null;
  if (lastRun?.status === "running" && !activeLease(db, lastRun.id, now)) {
    lastRun.status = "interrupted";
    lastRun.error = "La collecte précédente s’est arrêtée avant sa fin.";
  }
  const running = !!db
    .prepare("SELECT owner FROM collection_lock WHERE id=1 AND expires_at>?")
    .get(new Date(now).toISOString());
  return {
    enabled: !!current.enabled,
    intervalMinutes: current.interval_minutes,
    nextRunAt: current.enabled && !running ? current.next_run_at : null,
    running,
    lastRun,
  };
}

export function updateCollectionSchedule(
  db: DatabaseSync,
  enabled: boolean,
  intervalMinutes: number,
  now = Date.now(),
) {
  const parsed = parseCollectionSchedule(enabled, intervalMinutes);
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = schedule(db);
    const nextRunAt = !parsed.enabled
      ? null
      : !current.enabled
        ? new Date(now).toISOString()
        : current.interval_minutes !== parsed.intervalMinutes
          ? new Date(now + parsed.intervalMinutes * 60000).toISOString()
          : current.next_run_at;
    db.prepare(
      "UPDATE collection_schedule SET enabled=?,interval_minutes=?,next_run_at=? WHERE id=1",
    ).run(Number(parsed.enabled), parsed.intervalMinutes, nextRunAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function scheduleAfter(db: DatabaseSync, now: number) {
  const current = schedule(db);
  db.prepare("UPDATE collection_schedule SET next_run_at=? WHERE id=1").run(
    current.enabled
      ? new Date(now + current.interval_minutes * 60000).toISOString()
      : null,
  );
}

// Called inside the reservation transaction so another process cannot race recovery.
function recoverExpiredRun(db: DatabaseSync, now: number) {
  const latest = run(db);
  if (latest?.status === "running" && !activeLease(db, latest.run_id, now)) {
    db.prepare(
      "UPDATE collection_run SET status='interrupted',finished_at=?,error=? WHERE id=1 AND run_id=?",
    ).run(
      new Date(now).toISOString(),
      "La collecte précédente s’est arrêtée avant sa fin.",
      latest.run_id,
    );
    scheduleAfter(db, now);
  }
  db.prepare("DELETE FROM collection_lock WHERE id=1 AND expires_at<=?").run(
    new Date(now).toISOString(),
  );
}

export function reserveCollection(
  db: DatabaseSync,
  trigger: CollectionRun["trigger"],
  now = Date.now(),
): string | null {
  db.exec("BEGIN IMMEDIATE");
  try {
    recoverExpiredRun(db, now);
    const current = schedule(db);
    if (
      trigger === "scheduled" &&
      (!current.enabled ||
        !current.next_run_at ||
        Date.parse(current.next_run_at) > now)
    ) {
      db.exec("COMMIT");
      return null;
    }
    if (db.prepare("SELECT owner FROM collection_lock WHERE id=1").get()) {
      if (trigger === "scheduled") {
        db.exec("COMMIT");
        return null;
      }
      throw new Error("Une collecte est déjà en cours.");
    }
    const id = randomUUID();
    db.prepare(
      "INSERT INTO collection_lock (id,owner,expires_at) VALUES (1,?,?)",
    ).run(id, new Date(now + COLLECTION_LEASE_MS).toISOString());
    db.prepare(
      "INSERT INTO collection_run (id,run_id,trigger,started_at,status) VALUES (1,?,?,?,'running') ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,trigger=excluded.trigger,started_at=excluded.started_at,finished_at=NULL,status='running',result=NULL,error=NULL",
    ).run(id, trigger, new Date(now).toISOString());
    db.prepare(
      "UPDATE collection_schedule SET next_run_at=NULL WHERE id=1",
    ).run();
    db.exec("COMMIT");
    return id;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function renewCollectionLease(
  db: DatabaseSync,
  id: string,
  now = Date.now(),
) {
  const updated = db
    .prepare(
      "UPDATE collection_lock SET expires_at=? WHERE id=1 AND owner=? AND expires_at>?",
    )
    .run(
      new Date(now + COLLECTION_LEASE_MS).toISOString(),
      id,
      new Date(now).toISOString(),
    );
  if (!updated.changes) throw new CollectionLeaseError();
}

export function withCollectionLease<T>(
  db: DatabaseSync,
  id: string,
  write: () => T,
  now = Date.now(),
): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    renewCollectionLease(db, id, now);
    const result = write();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function finishCollection(
  db: DatabaseSync,
  id: string,
  result: CollectionResult,
  error: string | null,
  now = Date.now(),
) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!activeLease(db, id, now)) throw new CollectionLeaseError();
    const status =
      error || (result.failed > 0 && result.failed === result.checked)
        ? "failed"
        : result.failed > 0
          ? "partial"
          : "success";
    db.prepare(
      "UPDATE collection_run SET finished_at=?,status=?,result=?,error=? WHERE id=1 AND run_id=?",
    ).run(
      new Date(now).toISOString(),
      status,
      JSON.stringify(result),
      error?.slice(0, 500) ?? null,
      id,
    );
    scheduleAfter(db, now);
    db.prepare("DELETE FROM collection_lock WHERE id=1 AND owner=?").run(id);
    db.exec("COMMIT");
  } catch (failure) {
    db.exec("ROLLBACK");
    throw failure;
  }
}
