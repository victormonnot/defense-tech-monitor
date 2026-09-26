import { NextRequest, NextResponse } from "next/server";
import { collectSources, discoverSource } from "@/lib/collector";
import { resolveCollection } from "@/lib/connectors";
import { canonicalUrl, publicUrl } from "@/lib/feed";
import { validateRemoteUrl } from "@/lib/network";
import { getStore } from "@/lib/store";
import { parseProfile } from "@/lib/profile";
import { parseActivityBatch } from "@/lib/activity";
import { parseFolderName } from "@/lib/folders";
import { parseCollectionSchedule } from "@/lib/collection-state";
import { setJevMode, retryJevFailures } from "@/lib/jev-store";
import { parseFeedInput } from "@/lib/custom-feeds";
import { processArticleSummary } from "@/lib/summary-service";
import {
  assertRequestAccess,
  assertRequestOrigin,
  RequestAccessError,
} from "@/lib/request-access";
import type { Feedback } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function checkAccess(request: NextRequest, mutation = false) {
  try {
    const access = assertRequestAccess(request);
    assertRequestOrigin(request, access, mutation);
    return null;
  } catch (error) {
    return json(
      {
        error:
          error instanceof RequestAccessError
            ? error.message
            : "L’accès à l’application est momentanément indisponible.",
      },
      error instanceof RequestAccessError ? error.status : 503,
    );
  }
}

export async function GET(request: NextRequest) {
  const denied = checkAccess(request);
  if (denied) return denied;
  return json({ snapshot: getStore().snapshot() });
}

function text(value: unknown, label: string, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label} invalide.`);
  return value.trim();
}

export async function POST(request: NextRequest) {
  const denied = checkAccess(request, true);
  if (denied) return denied;
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return json({ error: "JSON requis." }, 415);
  try {
    const raw = await request.text();
    if (raw.length > 16000)
      return json({ error: "Requête trop volumineuse." }, 413);
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new Error("Requête invalide.");
    const store = getStore();
    let message: string | undefined;
    switch (body.action) {
      case "generateSummary": {
        const summary = await processArticleSummary(
          store,
          text(body.id, "Publication"),
        );
        if (summary.status === "failed")
          return json({
            snapshot: store.snapshot(),
            error: summary.reason ?? "La génération du résumé a échoué.",
          });
        message =
          summary.status === "ready"
            ? "Résumé en français disponible."
            : (summary.reason ?? "Résumé indisponible pour cette publication.");
        break;
      }
      case "createCustomFeed": {
        const feedId = store.saveCustomFeed(null, parseFeedInput(body.feed));
        return json({
          snapshot: store.snapshot(),
          feedId,
          message: "Fil personnalisé créé.",
        });
      }
      case "updateCustomFeed": {
        store.saveCustomFeed(
          text(body.id, "Fil"),
          parseFeedInput(body.feed),
          body.revision as number,
        );
        message =
          "Fil enregistré. Les résultats compatibles avec ses consignes sont conservés.";
        break;
      }
      case "setCustomFeedArchived": {
        if (typeof body.value !== "boolean")
          throw new Error("État du fil invalide.");
        store.setCustomFeedArchived(text(body.id, "Fil"), body.value);
        message = body.value
          ? "Fil archivé. Ses retours et résultats sont conservés."
          : "Fil réactivé.";
        break;
      }
      case "setFeedFeedback": {
        if (
          body.value !== null &&
          !["relevant", "off_topic", "seen"].includes(String(body.value))
        )
          throw new Error("Retour invalide.");
        store.setFeedFeedback(
          text(body.id, "Publication"),
          text(body.feedId, "Fil"),
          body.value as Feedback | null,
        );
        break;
      }
      case "setJevMode": {
        if (
          body.mode !== "off" &&
          body.mode !== "compare" &&
          body.mode !== "personal"
        )
          throw new Error("Mode Jev invalide.");
        setJevMode(store, body.mode);
        message =
          body.mode === "off"
            ? "Analyse Jev en pause. Les règles déterminent Pour moi ; les fils personnalisés conservent leurs résultats Jev."
            : body.mode === "compare"
              ? "Comparaison Jev activée. Les règles déterminent Pour moi ; les fils personnalisés utilisent leurs résultats Jev."
              : "Sélection Jev activée pour Pour moi. Les règles s’appliquent aux analyses absentes ou incertaines.";
        break;
      }
      case "retryJevFailures": {
        retryJevFailures(store);
        message =
          "Les analyses Jev en échec pourront être réessayées dans la limite du budget restant.";
        break;
      }
      case "updateCollectionSchedule": {
        const schedule = parseCollectionSchedule(
          body.enabled,
          body.intervalMinutes,
        );
        store.updateCollectionSchedule(
          schedule.enabled,
          schedule.intervalMinutes,
        );
        message = schedule.enabled
          ? "Collecte automatique activée tant que le serveur local fonctionne."
          : "Collecte automatique en pause. Une collecte déjà en cours peut se terminer.";
        break;
      }
      case "collect": {
        const result = await collectSources(store);
        message = `${result.added} nouvelle(s) publication(s), ${result.updated} mise(s) à jour. ${result.checked} source(s) consultée(s)${result.failed ? `, ${result.failed} en erreur` : ""}. ${result.skipped ? "Les sources désactivées, sans connecteur ou consultées récemment sont ignorées." : ""}`;
        break;
      }
      case "addSource": {
        const name = text(body.name, "Nom", 120);
        const siteUrl = canonicalUrl(
          text(body.siteUrl, "Adresse du site", 2000),
        );
        validateRemoteUrl(siteUrl);
        const feedUrl =
          typeof body.feedUrl === "string" && body.feedUrl.trim()
            ? publicUrl(body.feedUrl.trim())
            : resolveCollection(siteUrl, null)
              ? null
              : await discoverSource(siteUrl);
        if (feedUrl) validateRemoteUrl(feedUrl);
        const language =
          typeof body.language === "string" &&
          /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(body.language)
            ? body.language.split("-")[0]
            : "und";
        store.addSource({ name, siteUrl, feedUrl, language });
        message = resolveCollection(siteUrl, feedUrl)
          ? "Source enregistrée. Lancez la collecte pour récupérer ses publications."
          : "Source enregistrée, mais aucun flux RSS/Atom n’a été découvert. Vous pouvez renseigner une URL de flux.";
        break;
      }
      case "toggleSource": {
        if (typeof body.enabled !== "boolean")
          throw new Error("État invalide.");
        store.toggleSource(text(body.id, "Source"), body.enabled);
        break;
      }
      case "createFolder": {
        const folderId = store.createFolder(parseFolderName(body.name).name);
        return json({
          snapshot: store.snapshot(),
          folderId,
          message: "Dossier créé.",
        });
      }
      case "renameFolder": {
        store.renameFolder(
          text(body.id, "Dossier"),
          parseFolderName(body.name).name,
        );
        message = "Dossier renommé.";
        break;
      }
      case "setFolderArchived": {
        if (typeof body.value !== "boolean") throw new Error("État invalide.");
        store.setFolderArchived(text(body.id, "Dossier"), body.value);
        message = body.value
          ? "Dossier archivé. Son contenu est conservé."
          : "Dossier réactivé.";
        break;
      }
      case "setArticleFolder": {
        if (typeof body.value !== "boolean") throw new Error("État invalide.");
        store.setArticleFolder(
          text(body.id, "Publication"),
          text(body.folderId, "Dossier"),
          body.value,
        );
        message = body.value
          ? "Publication ajoutée au dossier."
          : "Publication retirée du dossier.";
        break;
      }
      case "setRead":
      case "setSaved":
      case "setSeparate": {
        if (typeof body.value !== "boolean") throw new Error("État invalide.");
        store.setArticleState(
          text(body.id, "Publication"),
          body.action === "setRead"
            ? "is_read"
            : body.action === "setSaved"
              ? "saved"
              : "keep_separate",
          body.value,
        );
        if (body.action === "setSeparate")
          message = body.value
            ? "Publication conservée séparément."
            : "Regroupement automatique rétabli pour cette publication.";
        break;
      }
      case "setFeedback": {
        if (
          body.value !== null &&
          !["relevant", "off_topic", "seen"].includes(String(body.value))
        )
          throw new Error("Retour invalide.");
        store.setArticleState(
          text(body.id, "Publication"),
          "feedback",
          body.value as Feedback | null,
        );
        break;
      }
      case "previewProfile": {
        return json({
          preview: store.previewProfile(parseProfile(body.profile)),
        });
      }
      case "acknowledgeChanges": {
        const articles = parseActivityBatch(body.articles);
        const count = store.acknowledgeChanges(articles);
        const snapshot = store.snapshot();
        const submitted = new Set(articles.map(({ id }) => id));
        const newer = snapshot.articles.filter(
          (article) => submitted.has(article.id) && article.changeKind !== null,
        ).length;
        message = count
          ? `${count} publication(s) validée(s) pour ce point de veille. Les états de lecture sont conservés.`
          : "Ces nouveautés ont déjà été validées.";
        if (newer)
          message += ` ${newer} publication(s) ont des modifications plus récentes qui restent à valider.`;
        return json({ snapshot, message });
      }
      case "updateProfile": {
        const profile = parseProfile(body.profile);
        store.setProfile(profile);
        message = "Profil enregistré et sélection recalculée.";
        break;
      }
      default:
        return json({ error: "Action inconnue." }, 400);
    }
    return json({ snapshot: store.snapshot(), message });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "La requête a échoué.",
      },
      400,
    );
  }
}
