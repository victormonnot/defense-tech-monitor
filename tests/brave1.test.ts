import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { parseBrave1Page } from "../src/lib/connectors/brave1";

// Synthetic publisher structures only; no real article text is reproduced.
const pageUrl = "https://brave1.gov.ua/en/news";
const page = (cards: string, outside = "") =>
  `<html lang="uk"><body>${outside}<main><app-news-home-list><app-news-cards-list>${cards}</app-news-cards-list></app-news-home-list></main></body></html>`;
const card = (
  href = "/en/news/langPrefix/news/fixture-article",
  title = "Fixture article",
  date = '<time datetime="2026-09-25T09:01:00.000Z">2026.09.25 | 09:01</time>',
) =>
  `<app-news-card><div class="block__tags">Manufacturers</div><img src="https://files.brave1.gov.ua/fixture.jpg"><h3 class="block__title"><a class="block__title-link" href="${href}">${title}</a></h3>${date}<div class="block__read-time">news.read-time</div></app-news-card>`;

test("Brave1 reads English article metadata from the official news cards", () => {
  const [article] = parseBrave1Page(page(card()), pageUrl);
  assert.equal(article.url, "https://brave1.gov.ua/en/news/fixture-article");
  assert.equal(article.guid, article.url);
  assert.equal(article.title, "Fixture article");
  assert.equal(article.publishedAt, "2026-09-25T09:01:00.000Z");
  assert.equal(article.language, "en");
  assert.equal(article.format, "article");
  assert.equal(article.text, "");
  assert.equal(article.excerpt, null);
  assert.equal(article.contentBasis, "metadata");
  const { contentHash, ...payload } = article;
  assert.equal(
    contentHash,
    createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  );
});

test("Brave1 decodes title entities and excludes scripts and other non-content elements", () => {
  const [article] = parseBrave1Page(
    page(
      card(
        undefined,
        "Fixture &amp; <strong>research</strong><script>hidden()</script><style>.secret{}</style><noscript>hidden fallback</noscript><iframe>hidden frame</iframe><template>hidden template</template>",
      ),
    ),
    pageUrl,
  );
  assert.equal(article.title, "Fixture & research");
  assert.equal(article.excerpt, null);
});

test("Brave1 ignores navigation, images, unrelated cards and hidden template cards", () => {
  const outside = `<nav><h3 class="block__title"><a class="block__title-link" href="/en/news/fake-menu">Menu</a></h3></nav>${card("/en/news/outside-list")}<template>${card("/en/news/hidden-template")}</template>`;
  const articles = parseBrave1Page(page(card(), outside), pageUrl);
  assert.equal(articles.length, 1);
  assert.equal(articles[0].title, "Fixture article");
});

test("Brave1 rejects non-official, unsafe and non-article links", () => {
  const invalidLinks = [
    "https://elsewhere.example/en/news/fixture",
    "https://brave1.gov.ua.evil.example/en/news/fixture",
    "https://user:password@brave1.gov.ua/en/news/fixture",
    "http://brave1.gov.ua/en/news/fixture",
    "https://files.brave1.gov.ua/en/news/fixture",
    "javascript:alert(1)",
    "/en/news",
    "/en/news/langPrefix",
    "/en/news/image.jpg",
    "/en/news/fixture/more",
    "/en/langPrefix/news/unobserved-prefix",
  ];
  const articles = parseBrave1Page(
    page(card() + invalidLinks.map((href) => card(href)).join("")),
    pageUrl,
  );
  assert.equal(articles.length, 1);
});

test("Brave1 deduplicates canonical URLs and preserves stable hashes", () => {
  const tracked = card(
    "/en/news/langPrefix/news/fixture-article?utm_source=fixture#section",
  );
  const canonical = card("/en/news/fixture-article/");
  const articles = parseBrave1Page(page(tracked + canonical), pageUrl);
  assert.equal(articles.length, 1);
  assert.deepEqual(articles, parseBrave1Page(page(card()), pageUrl));
  const [changed] = parseBrave1Page(
    page(card(undefined, "Changed fixture")),
    pageUrl,
  );
  assert.notEqual(changed.contentHash, articles[0].contentHash);
});

test("Brave1 preserves explicit timezones and date-only values", () => {
  for (const [markup, expected] of [
    [
      '<time datetime="2026-09-25T11:01:00+02:00"></time>',
      "2026-09-25T09:01:00.000Z",
    ],
    ['<time datetime="2026-09-25"></time>', "2026-09-25"],
    ["<time>2026.09.25 | 09:01</time>", "2026-09-25"],
    ["<time>2024.02.29</time>", "2024-02-29"],
    [
      '<time datetime="2026-09-25T09:01:00">2026.09.25 | 09:01</time>',
      "2026-09-25",
    ],
  ]) {
    const [article] = parseBrave1Page(
      page(card(undefined, undefined, markup)),
      pageUrl,
    );
    assert.equal(article.publishedAt, expected);
  }
});

test("Brave1 never substitutes a collection date for invalid or missing publication dates", () => {
  for (const markup of [
    "",
    "<time></time>",
    '<time datetime="not-a-date">unknown</time>',
    '<time datetime="2026-02-30T12:00:00Z">2026.02.30 | 12:00</time>',
    '<time datetime="2026-09-25T25:00:00Z">2026.09.25 | 25:00</time>',
    "<time>2025.02.29</time>",
    "<time>2026.13.01</time>",
  ]) {
    const [article] = parseBrave1Page(
      page(card(undefined, undefined, markup)),
      pageUrl,
    );
    assert.equal(article.publishedAt, null);
  }
});

test("Brave1 surfaces absent or changed listing structures as errors", () => {
  for (const html of [
    "<html><body>Source unavailable</body></html>",
    page(""),
    page(card().replaceAll("app-news-card", "renamed-card")),
    page(card().replaceAll("block__title-link", "renamed-link")),
    page(card(undefined, "")),
    page(card("https://elsewhere.example/en/news/fixture")),
  ]) {
    assert.throws(() => parseBrave1Page(html, pageUrl), /Brave1/);
  }
});

test("Brave1 only accepts its official English listing as a parse base", () => {
  for (const base of [
    "https://elsewhere.example/en/news",
    "https://user:password@brave1.gov.ua/en/news",
    "https://brave1.gov.ua/news",
    "https://brave1.gov.ua/en/",
    "http://brave1.gov.ua/en/news",
  ]) {
    assert.throws(() => parseBrave1Page(page(card()), base), /Brave1/);
  }
});
