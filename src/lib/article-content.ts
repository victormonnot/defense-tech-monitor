import { canonicalUrl } from "./feed";
import { extractBrave1Article } from "./connectors/brave1-article";
import { extractDefenderArticle } from "./connectors/defender-article";

/** Article extraction is deliberately limited to the supported public sites. */
export function articleContentTarget(
  siteUrl: string,
  feedUrl: string | null,
  articleUrl: string,
) {
  if (feedUrl) return null;
  try {
    const site = new URL(canonicalUrl(siteUrl));
    const article = new URL(canonicalUrl(articleUrl));
    if (article.protocol !== "https:" || article.search) return null;
    if (
      site.hostname === "brave1.gov.ua" &&
      /^\/en(?:\/news)?\/?$/.test(site.pathname) &&
      article.origin === "https://brave1.gov.ua" &&
      /^\/en\/news\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/.test(article.pathname)
    )
      return { url: article.toString(), extract: extractBrave1Article };
    if (
      site.hostname === "thedefender.media" &&
      /^\/en\/?$/.test(site.pathname) &&
      article.origin === "https://thedefender.media" &&
      /^\/en\/(?:(?:19|20)\d{2}\/(?:0[1-9]|1[0-2])|insights)\/[a-z0-9][a-z0-9-]*\/?$/.test(
        article.pathname,
      )
    )
      return { url: article.toString(), extract: extractDefenderArticle };
  } catch {
    // Invalid URLs and unsupported sources keep their original collected text.
  }
  return null;
}

export function sameArticleUrl(expected: string, actual: string) {
  try {
    const a = new URL(canonicalUrl(expected));
    const b = new URL(canonicalUrl(actual));
    return (
      a.origin === b.origin &&
      a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "") &&
      a.search === b.search
    );
  } catch {
    return false;
  }
}
