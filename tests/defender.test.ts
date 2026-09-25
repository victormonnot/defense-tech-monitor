import assert from "node:assert/strict";
import test from "node:test";
import { parseDefenderPage } from "../src/lib/connectors/defender";

// Synthetic fixtures only; no publisher article text is stored in this suite.
const pageUrl = "https://thedefender.media/en/";
const articlePath = "/en/2026/09/fixture-update/";
const card = ({
  href = articlePath,
  title = "Synthetic update",
  date = '<time class="entry-date published" datetime="2026-09-25T12:30:00+03:00">September 25, 2026</time>',
  excerpt = "Synthetic excerpt about a fictional project.",
  excerptHref = href,
}: {
  href?: string;
  title?: string;
  date?: string;
  excerpt?: string;
  excerptHref?: string;
} = {}) =>
  `<article class="one-news"><div class="news-meta">${date}</div><h2 class="entry-title"><a href="${href}">${title}</a></h2>${excerpt ? `<a class="excerpt-link" href="${excerptHref}"><p>${excerpt}</p></a>` : ""}</article>`;
const featured = (date: string, href = articlePath) =>
  `<div class="article featured-article"><span class="article-data-date">${date}</span><h3 class="article-title"><a href="${href}">Synthetic update</a></h3></div>`;

test("Defender reads card metadata and actual excerpts with canonical relative URLs", () => {
  const [entry] = parseDefenderPage(
    card({ href: `${articlePath}?utm_source=fixture&fbclid=one#top` }),
    pageUrl,
  );
  assert.equal(entry.url, `https://thedefender.media${articlePath}`);
  assert.equal(entry.guid, entry.url);
  assert.equal(entry.title, "Synthetic update");
  assert.equal(entry.publishedAt, "2026-09-25T09:30:00.000Z");
  assert.equal(entry.text, "Synthetic excerpt about a fictional project.");
  assert.equal(entry.excerpt, entry.text);
  assert.equal(entry.contentBasis, "page_excerpt");
  assert.equal(entry.language, "en");
  assert.equal(entry.format, "article");
});

test("Defender keeps date-only precision for featured and trending cards", () => {
  const html = `${featured("25 September 2026")}<a class="trending-news-box" href="/en/2026/09/second-fixture/"><div class="sidebar-article-data"><span>September 24, 2026</span></div><h3 class="article-title">Second synthetic update</h3></a>`;
  const entries = parseDefenderPage(html, pageUrl);
  assert.deepEqual(
    entries.map((entry) => entry.publishedAt),
    ["2026-09-25", "2026-09-24"],
  );
  for (const entry of entries) {
    assert.equal(entry.excerpt, null);
    assert.equal(entry.text, "");
    assert.equal(entry.contentBasis, "metadata");
  }
});

test("Defender does not invent a timezone for unzoned publication timestamps", () => {
  for (const date of ["2026-09-25", "2026-09-25T13:45:00"]) {
    const [entry] = parseDefenderPage(
      card({ date: `<time class="published" datetime="${date}"></time>` }),
      pageUrl,
    );
    assert.equal(entry.publishedAt, "2026-09-25");
  }
});

test("Defender rejects invalid dates and never derives a day from the URL or update date", () => {
  for (const date of [
    "",
    '<time class="updated" datetime="2026-09-26T12:00:00Z">September 26, 2026</time>',
    '<time class="published" datetime="not-a-date"></time>',
    '<time class="published" datetime="2026-02-30T12:00:00Z"></time>',
    '<time class="published" datetime="2026-09-25T27:00:00Z"></time>',
    '<span class="article-data-date">31 February 2026</span>',
  ]) {
    assert.equal(
      parseDefenderPage(card({ date }), pageUrl)[0].publishedAt,
      null,
    );
  }
});

test("Defender accepts only article URLs on the exact official origin", () => {
  const invalid = [
    "javascript:alert(1)",
    "https://thedefender.media.evil.test/en/2026/09/fixture/",
    "https://thedefender.media@evil.test/en/2026/09/fixture/",
    "https://user:password@thedefender.media/en/2026/09/fixture/",
    "//evil.test/en/2026/09/fixture/",
    "http://thedefender.media/en/2026/09/fixture/",
    "https://thedefender.media:444/en/2026/09/fixture/",
    "/en/categories/innovation/",
    "/en/insights/",
    "/en/2026/09/",
    "/en/2026/13/invalid-month/",
    "/en/2026/09/fixture/nested/",
    "/2026/09/non-english/",
  ];
  const entries = parseDefenderPage(
    invalid.map((href) => card({ href })).join("") + card(),
    pageUrl,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, `https://thedefender.media${articlePath}`);
});

test("Defender excludes navigation, advertising and read-more-only links", () => {
  const html = `<nav>${card({ href: "/en/2026/09/navigation/" })}</nav><div class="advertisement">${card({ href: "/en/2026/09/advertisement/" })}</div>${card({ title: "Read more", href: "/en/2026/09/read-more/" })}<a href="/en/2026/09/unstructured-link/">Loose link</a>${card()}`;
  assert.equal(parseDefenderPage(html, pageUrl).length, 1);
});

test("Defender keeps the richest duplicate card regardless of section order", () => {
  for (const html of [
    featured("25 September 2026") + card(),
    card() + featured("25 September 2026"),
  ]) {
    const entries = parseDefenderPage(html, pageUrl);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].contentBasis, "page_excerpt");
    assert.equal(entries[0].publishedAt, "2026-09-25T09:30:00.000Z");
    assert.equal(
      entries[0].excerpt,
      "Synthetic excerpt about a fictional project.",
    );
  }
});

test("Defender combines missing metadata from duplicate cards", () => {
  const [entry] = parseDefenderPage(
    card({ date: "" }) + featured("25 September 2026"),
    pageUrl,
  );
  assert.equal(entry.publishedAt, "2026-09-25");
  assert.equal(entry.contentBasis, "page_excerpt");
});

test("Defender deduplicates trailing slashes and tracking variants", () => {
  const entries = parseDefenderPage(
    card({ href: articlePath.slice(0, -1) }) +
      card({ href: `${articlePath}?utm_campaign=fixture#top` }),
    pageUrl,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, `https://thedefender.media${articlePath}`);
});

test("Defender excludes cards embedded inside non-content elements", () => {
  const hidden = ["script", "style", "noscript", "iframe", "template"]
    .map(
      (tag) =>
        `<${tag}>${card({ href: `/en/2026/09/hidden-${tag}/` })}</${tag}>`,
    )
    .join("");
  assert.equal(parseDefenderPage(hidden + card(), pageUrl).length, 1);
  assert.throws(() => parseDefenderPage(hidden, pageUrl), /aucune carte/);
});

test("Defender never substitutes titles, calls to action or another article's text for an excerpt", () => {
  for (const options of [
    { excerpt: "" },
    { excerpt: "Read more" },
    { excerpt: "Synthetic update" },
    { excerptHref: "/en/2026/09/some-other-article/" },
  ]) {
    const [entry] = parseDefenderPage(card(options), pageUrl);
    assert.equal(entry.text, "");
    assert.equal(entry.excerpt, null);
    assert.equal(entry.contentBasis, "metadata");
  }
});

test("Defender includes insights article cards but not the insights navigation link", () => {
  const html = `<div class="article swiper-slide"><time class="published" datetime="2026-09-20T10:00:00Z"></time><h3 class="insights-article-title"><a href="/en/insights/synthetic-analysis/">Synthetic analysis</a></h3></div><a href="/en/insights/">All articles</a>`;
  const [entry] = parseDefenderPage(html, pageUrl);
  assert.equal(
    entry.url,
    "https://thedefender.media/en/insights/synthetic-analysis/",
  );
  assert.equal(entry.title, "Synthetic analysis");
  assert.equal(entry.publishedAt, "2026-09-20T10:00:00.000Z");
  assert.equal(entry.contentBasis, "metadata");
});

test("Defender removes markup and non-content elements from extracted text", () => {
  const [entry] = parseDefenderPage(
    card({
      title: "Synthetic &amp; safe <script>badTitle()</script>",
      excerpt:
        "First <strong>synthetic</strong> sentence.<script>badExcerpt()</script><span class='read-more'>Read more</span>",
    }),
    pageUrl,
  );
  assert.equal(entry.title, "Synthetic & safe");
  assert.equal(entry.excerpt, "First synthetic sentence.");
});

test("Defender content hashes are stable and respond to excerpt availability", () => {
  const metadata = parseDefenderPage(card({ excerpt: "" }), pageUrl)[0];
  const withExcerpt = parseDefenderPage(card(), pageUrl)[0];
  assert.equal(
    withExcerpt.contentHash,
    parseDefenderPage(card(), pageUrl)[0].contentHash,
  );
  assert.notEqual(metadata.contentHash, withExcerpt.contentHash);
});

test("Defender surfaces empty or changed page structure as an error", () => {
  for (const html of [
    "",
    "<html><h1>Temporarily unavailable</h1></html>",
    `<div class="new-card"><h2><a href="${articlePath}">Synthetic update</a></h2></div>`,
  ])
    assert.throws(
      () => parseDefenderPage(html, pageUrl),
      /aucune carte.*structure/i,
    );
});

test("Defender requires the official English homepage as its page context", () => {
  for (const url of [
    "https://evil.test/en/",
    "https://thedefender.media/",
    "https://thedefender.media/en/insights/",
    "https://user:secret@thedefender.media/en/",
  ])
    assert.throws(
      () => parseDefenderPage(card(), url),
      /page d’accueil anglaise/,
    );
});
