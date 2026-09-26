"use client";

import {
  CalendarClock,
  CircleAlert,
  Clock3,
  LoaderCircle,
  Pause,
  Play,
} from "lucide-react";
import type { MonitorAction, Snapshot } from "@/lib/types";

const frequencies = [
  { value: 15, label: "Toutes les 15 minutes" },
  { value: 30, label: "Toutes les 30 minutes" },
  { value: 60, label: "Toutes les heures" },
  { value: 180, label: "Toutes les 3 heures" },
  { value: 360, label: "Toutes les 6 heures" },
  { value: 720, label: "Toutes les 12 heures" },
  { value: 1440, label: "Chaque jour" },
];

function timestamp(value: string) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function CollectionSchedule({
  collection,
  busy,
  onAction,
}: {
  collection: Snapshot["collection"];
  busy: boolean;
  onAction: (action: MonitorAction) => void;
}) {
  const lastRun = collection.lastRun;
  const status = lastRun?.status;
  const statusLabel =
    status === "running"
      ? "Collecte en cours"
      : status === "success"
        ? "Collecte terminée"
        : status === "partial"
          ? "Collecte partielle"
          : status === "failed"
            ? "Collecte en erreur"
            : "Collecte interrompue";
  const hasError =
    status === "failed" || status === "partial" || status === "interrupted";
  return (
    <section
      className="collection-schedule"
      aria-labelledby="collection-schedule-title"
    >
      <div className="schedule-heading">
        <div className="schedule-title">
          <CalendarClock size={20} />
          <h2 id="collection-schedule-title">Collecte automatique</h2>
          <span
            className={`schedule-mode ${collection.enabled ? "is-enabled" : ""}`}
          >
            {collection.enabled ? "Activée" : "En pause"}
          </span>
        </div>
        <button
          className="button button-secondary"
          type="button"
          disabled={busy}
          onClick={() =>
            onAction({
              action: "updateCollectionSchedule",
              enabled: !collection.enabled,
              intervalMinutes: collection.intervalMinutes,
            })
          }
        >
          {collection.enabled ? <Pause size={15} /> : <Play size={15} />}
          {collection.enabled
            ? "Mettre en pause"
            : "Activer la collecte automatique"}
        </button>
      </div>
      <div className="schedule-options">
        <div className="schedule-frequency">
          <label htmlFor="collection-frequency">Fréquence</label>
          <select
            id="collection-frequency"
            value={collection.intervalMinutes}
            disabled={busy}
            onChange={(event) =>
              onAction({
                action: "updateCollectionSchedule",
                enabled: collection.enabled,
                intervalMinutes: Number(event.target.value),
              })
            }
          >
            {!frequencies.some(
              (frequency) => frequency.value === collection.intervalMinutes,
            ) && (
              <option value={collection.intervalMinutes}>
                Toutes les {collection.intervalMinutes} minutes
              </option>
            )}
            {frequencies.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="schedule-next" role="status">
          {collection.running ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Clock3 size={16} />
          )}
          <span>
            {collection.running ? (
              collection.enabled ? (
                "Une collecte est en cours."
              ) : (
                "La collecte en cours se termine ; les suivantes sont en pause."
              )
            ) : collection.enabled && collection.nextRunAt ? (
              <>
                Prochaine collecte :{" "}
                <time dateTime={collection.nextRunAt}>
                  {timestamp(collection.nextRunAt)}
                </time>
              </>
            ) : collection.enabled ? (
              "Première collecte à venir."
            ) : (
              "Aucune collecte automatique programmée."
            )}
          </span>
        </div>
      </div>
      <p className="schedule-help">
        La collecte continue même si cet onglet est fermé, tant que le serveur
        local reste lancé. Le délai minimum entre deux consultations reste
        appliqué à chaque source.
      </p>
      {lastRun && (
        <div
          className={`schedule-last-run ${hasError ? "has-error" : ""}`}
          role="status"
        >
          <div className="schedule-run-heading">
            <strong>
              {hasError && <CircleAlert size={15} />}
              {statusLabel}
            </strong>
            <span>
              {lastRun.trigger === "scheduled"
                ? "Automatique"
                : lastRun.trigger === "cli"
                  ? "Ligne de commande"
                  : "Manuelle"}{" "}
              ·{" "}
              <time dateTime={lastRun.finishedAt ?? lastRun.startedAt}>
                {timestamp(lastRun.finishedAt ?? lastRun.startedAt)}
              </time>
            </span>
          </div>
          {lastRun.result && (
            <p>
              {lastRun.result.added} nouvelle
              {lastRun.result.added > 1 ? "s" : ""} publication
              {lastRun.result.added > 1 ? "s" : ""} · {lastRun.result.updated}{" "}
              mise{lastRun.result.updated > 1 ? "s" : ""} à jour ·{" "}
              {lastRun.result.checked} source
              {lastRun.result.checked > 1 ? "s" : ""} consultée
              {lastRun.result.checked > 1 ? "s" : ""}
              {lastRun.result.failed > 0 &&
                ` · ${lastRun.result.failed} en erreur`}
              {lastRun.result.skipped > 0 &&
                ` · ${lastRun.result.skipped} ignorée${lastRun.result.skipped > 1 ? "s" : ""}`}
              {!!lastRun.result.contentChecked &&
                ` · ${lastRun.result.contentUpdated ?? 0} texte(s) enrichi(s) sur ${lastRun.result.contentChecked} page(s) consultée(s)`}
              {!!lastRun.result.contentFailed &&
                ` · ${lastRun.result.contentFailed} texte(s) non récupéré(s)`}
            </p>
          )}
          {lastRun.error && <p className="schedule-error">{lastRun.error}</p>}
          {status === "interrupted" && !lastRun.error && (
            <p>Cette collecte n’a pas pu aller à son terme.</p>
          )}
        </div>
      )}
    </section>
  );
}
