import { AtSign, CircleAlert } from "lucide-react";
import type { Snapshot } from "@/lib/types";
import styles from "./x-source-status.module.css";

function usd(value: number) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 3,
  }).format(value);
}

export function XSourceStatus({
  state,
}: {
  state: NonNullable<Snapshot["x"]>;
}) {
  const needsConfiguration = !state.configured || state.monthlyBudgetUsd <= 0;
  const budgetInsufficient = !needsConfiguration && state.remainingUsd < 0.025;
  const status = needsConfiguration
    ? "Configuration requise"
    : budgetInsufficient
      ? "Budget restant insuffisant"
      : state.error
        ? "À vérifier"
        : "Configuré";

  return (
    <section className={styles.panel} aria-labelledby="x-source-status-title">
      <div className={styles.heading}>
        <div className={styles.title}>
          <AtSign size={19} aria-hidden="true" />
          <h2 id="x-source-status-title">Comptes X</h2>
          <span className={styles.status}>{status}</span>
        </div>
        <dl className={styles.budget} aria-label="Budget mensuel de collecte X">
          <div>
            <dt>Consommation estimée</dt>
            <dd>{usd(state.spentUsd)}</dd>
          </div>
          <div>
            <dt>Plafond mensuel</dt>
            <dd>{usd(state.monthlyBudgetUsd)}</dd>
          </div>
          <div>
            <dt>Restant</dt>
            <dd>{usd(state.remainingUsd)}</dd>
          </div>
        </dl>
      </div>
      <p className={styles.help}>
        L’API X est payante. Ce plafond est propre à la collecte X et ne
        représente pas votre solde chez X. Ajouter un compte ne lance aucune
        requête à son API.
      </p>
      {state.error && (
        <p className={styles.error}>
          <CircleAlert size={15} aria-hidden="true" />
          <span>{state.error}</span>
        </p>
      )}
      <details className={styles.setup} open={needsConfiguration}>
        <summary>Configuration et fonctionnement</summary>
        <p>
          {needsConfiguration
            ? "Pour permettre la collecte, renseignez "
            : "La configuration du serveur utilise "}
          <code>X_BEARER_TOKEN</code> et un plafond positif avec{" "}
          <code>DTM_X_MONTHLY_BUDGET_USD</code> dans <code>.env.local</code> en
          local ou dans les variables d’environnement Coolify sur le VPS. Puis
          redémarrez le serveur local ou redéployez l’application sur le VPS. Un
          plafond de 0 bloque les appels X.
        </p>
        <p>
          Les comptes actifs sont consultés lors d’une collecte manuelle ou
          automatique, dans la limite de ce budget. Leurs publications utilisent
          ensuite les mêmes fils, classements et résumés que vos autres sources.
        </p>
      </details>
    </section>
  );
}
