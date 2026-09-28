import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

// X's published read prices, in integer millionths of a USD. No expansions
// are requested, so only the user lookup and returned posts are billed.
export const X_POST_MICROS = 5_000;
export const X_USER_MICROS = 10_000;

export interface XConfig {
  apiKey: string;
  monthlyBudgetUsd: number;
  error: string | null;
}

export interface XState {
  configured: boolean;
  monthlyBudgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  error: string | null;
}

export function xConfig(): XConfig {
  const apiKey = process.env.X_BEARER_TOKEN?.trim() ?? "";
  const cap = Number(process.env.DTM_X_MONTHLY_BUDGET_USD ?? 0);
  const valid = Number.isFinite(cap) && cap >= 0 && cap <= 1000;
  const validKey = apiKey.length <= 4096 && /^[\x21-\x7e]+$/.test(apiKey);
  return {
    apiKey,
    monthlyBudgetUsd: valid ? Math.floor(cap * 1e6) / 1e6 : 0,
    error: !valid
      ? "Le plafond X doit être un montant en USD compris entre 0 et 1 000."
      : !apiKey
        ? "Ajoutez le Bearer Token X dans la configuration du serveur."
        : !validKey
          ? "Le Bearer Token X a un format invalide. Vérifiez la configuration du serveur."
          : cap === 0
            ? "La collecte X est désactivée : définissez un plafond mensuel positif."
            : null,
  };
}

function spentMicros(db: DatabaseSync, now: number) {
  return Number(
    db
      .prepare(
        "SELECT COALESCE(SUM(COALESCE(settled_micros,reserved_micros)),0) AS total FROM x_requests WHERE month=?",
      )
      .get(new Date(now).toISOString().slice(0, 7))!.total,
  );
}

export function xSnapshot(
  db: DatabaseSync,
  config = xConfig(),
  now = Date.now(),
): XState {
  const spent = spentMicros(db, now);
  const limit = Math.floor(config.monthlyBudgetUsd * 1e6);
  return {
    configured: !!config.apiKey && !config.error && limit > 0,
    monthlyBudgetUsd: config.monthlyBudgetUsd,
    spentUsd: spent / 1e6,
    remainingUsd: Math.max(0, limit - spent) / 1e6,
    error: config.error,
  };
}

export interface XReservation {
  id: string;
  count: number;
  unitMicros: number;
}

export function reserveXRequest(
  db: DatabaseSync,
  kind: "user" | "posts",
  config = xConfig(),
  now = Date.now(),
): XReservation {
  if (config.error || !config.apiKey || config.monthlyBudgetUsd <= 0)
    throw new Error(config.error ?? "La collecte X n’est pas configurée.");
  db.exec("BEGIN IMMEDIATE");
  try {
    const remaining =
      Math.floor(config.monthlyBudgetUsd * 1e6) - spentMicros(db, now);
    const unitMicros = kind === "user" ? X_USER_MICROS : X_POST_MICROS;
    const count =
      kind === "user" ? 1 : Math.min(10, Math.floor(remaining / unitMicros));
    if (remaining < count * unitMicros || count < (kind === "user" ? 1 : 5))
      throw new Error(
        "Le budget X restant ne permet pas la prochaine requête. La collecte reprendra après renouvellement du plafond mensuel.",
      );
    const id = randomUUID();
    db.prepare(
      "INSERT INTO x_requests (id,month,kind,reserved_micros,started_at,status) VALUES (?,?,?,?,?,'running')",
    ).run(
      id,
      new Date(now).toISOString().slice(0, 7),
      kind,
      count * unitMicros,
      new Date(now).toISOString(),
    );
    db.exec("COMMIT");
    return { id, count, unitMicros };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function settleXRequest(
  db: DatabaseSync,
  reservation: XReservation,
  count: number | null,
  now = Date.now(),
) {
  if (
    count !== null &&
    (!Number.isSafeInteger(count) || count < 0 || count > reservation.count)
  )
    throw new Error("Le nombre de ressources X reçues est invalide.");
  // Failed or interrupted calls retain their full reservation: the provider
  // may have processed a request even if its response never reached us.
  db.prepare(
    "UPDATE x_requests SET status=?,settled_micros=?,resource_count=?,finished_at=? WHERE id=? AND status='running'",
  ).run(
    count === null ? "failed" : "success",
    count === null ? null : count * reservation.unitMicros,
    count,
    new Date(now).toISOString(),
    reservation.id,
  );
}
