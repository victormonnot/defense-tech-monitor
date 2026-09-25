import Parser from "rss-parser";
import { load } from "cheerio";
import { createHash } from "node:crypto";
import type { ContentBasis } from "./types";

export interface FeedEntry {
  guid: string;
  url: string;
  title: string;
  publishedAt: string | null;
  text: string;
  excerpt: string | null;
  language: string;
  format: "article" | "video";
  contentHash: string;
  contentBasis?: ContentBasis;
}

export function publicUrl(value: string, base?: string): string {
  const url = new URL(value, base);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("URL HTTP(S) sans identifiants requise.");
  url.hash = "";
  return url.toString();
}

export function canonicalUrl(value: string, base?: string): string {
  const url = new URL(publicUrl(value, base));
  for (const key of [...url.searchParams.keys()]) {
    if (
      /^utm_/i.test(key) ||
      ["fbclid", "gclid", "mc_cid", "mc_eid"].includes(key.toLowerCase())
    )
      url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

export function plainText(html: string): string {
  const $ = load(html);
  $("script, style, noscript, iframe, template").remove();
  $("br, p, div, li, h1, h2, h3, h4, blockquote").each((_, node) => {
    $(node).prepend(" ").append(" ");
  });
  return $.root().text().replace(/\s+/g, " ").trim();
}

export function discoverFeed(html: string, siteUrl: string): string | null {
  const $ = load(html);
  const link = $('link[rel~="alternate"]')
    .toArray()
    .find((node) =>
      /application\/(rss|atom)\+xml/i.test($(node).attr("type") ?? ""),
    );
  const href = link && $(link).attr("href");
  return href ? publicUrl(href, siteUrl) : null;
}

export async function parseFeed(
  xml: string,
  feedUrl: string,
  fallbackLanguage: string,
): Promise<FeedEntry[]> {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("Déclarations XML externes non prises en charge.");
  if (!/<(?:rss|feed|rdf:RDF)(?:\s|>)/i.test(xml.slice(0, 4000)))
    throw new Error("La source ne renvoie pas un flux RSS ou Atom.");
  // rss-parser throws on invalid Atom dates and treats updated as published.
  // Preserve unknown publication dates instead of manufacturing a chronology.
  const document = load(xml, { xml: true });
  document("entry > updated").remove();
  document("entry > published").each((_, node) => {
    if (!Number.isFinite(Date.parse(document(node).text())))
      document(node).remove();
  });
  const parsed = await new Parser().parseString(document.xml());
  const language = (
    parsed.language ||
    document("feed").attr("xml:lang") ||
    fallbackLanguage ||
    "und"
  )
    .toLowerCase()
    .split(/[-_]/)[0];
  const entries: FeedEntry[] = [];
  for (const item of parsed.items.slice(0, 200)) {
    if (!item.link || !item.title) continue;
    let url: string;
    try {
      url = canonicalUrl(item.link, feedUrl);
    } catch {
      continue;
    }
    const title = plainText(item.title).slice(0, 1000);
    if (!title) continue;
    const text = plainText(
      item["content:encoded"] ||
        item.content ||
        item.summary ||
        item.contentSnippet ||
        "",
    ).slice(0, 20000);
    const excerpt =
      plainText(item.summary || item.content || text).slice(0, 480) || null;
    const rawDate = item.isoDate || item.pubDate;
    const date = rawDate ? new Date(rawDate) : null;
    const publishedAt =
      date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
    const format =
      item.enclosure?.type?.startsWith("video/") ||
      /(?:youtube\.com|youtu\.be|vimeo\.com)$/.test(new URL(url).hostname)
        ? "video"
        : "article";
    entries.push({
      guid: item.guid || item.id || url,
      url,
      title,
      publishedAt,
      text,
      excerpt,
      language,
      format,
      contentHash: createHash("sha256")
        .update(
          JSON.stringify([
            url,
            title,
            publishedAt,
            text,
            excerpt,
            language,
            format,
          ]),
        )
        .digest("hex"),
    });
  }
  if (parsed.items.length > 0 && entries.length === 0)
    throw new Error(
      "Le flux contient des entrées, mais aucune publication avec titre et lien utilisables.",
    );
  return entries;
}
