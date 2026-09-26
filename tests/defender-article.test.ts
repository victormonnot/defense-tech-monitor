import assert from "node:assert/strict";
import test from "node:test";
import { extractDefenderArticle } from "../src/lib/connectors/defender-article";

// Synthetic fixtures only; no publisher body text is checked into the repository.
const url = "https://thedefender.media/en/2026/09/synthetic-update/";
const first =
  "This synthetic report describes a fictional research programme and its public announcement. The team explains how its prototype was reviewed by independent observers during a routine demonstration, and identifies the remaining work before the next evaluation.";
const second =
  "A separate fictional organisation provided comments on the announcement. Its representatives said that the current results should be interpreted in context, because further evaluation and public reporting are still expected before the project reaches its next stage.";
const prose = `<p class="wp-block-paragraph">${first}</p><p class="wp-block-paragraph">${second}</p>`;
function page(
  content = prose,
  options: {
    head?: string;
    lang?: string;
    bodyAttrs?: string;
    sectionAttrs?: string;
    title?: string;
  } = {},
) {
  return `<html${options.lang === "" ? "" : ` lang="${options.lang ?? "en-US"}"`}><head>${options.head ?? `<link rel="canonical" href="${url}"><meta property="og:url" content="${url}"><meta property="og:locale" content="en_US">`}</head><body ${options.bodyAttrs ?? ""}><section class="blog-post" ${options.sectionAttrs ?? ""}><div class="blog-post-container container"><div class="blog-post-data"><h1>${options.title ?? "A synthetic announcement"}</h1></div><div class="container single-article">${content}</div></div></section></body></html>`;
}

test("Defender article extraction reads only the visible editorial body", () => {
  const html = page(
    `<div class="share-wrap"><p>Copied share text</p></div>${prose}<div class="wp-block-buttons"><p>Read a promoted story</p></div>`,
  ).replace(
    "</body>",
    `<nav><p>Navigation noise</p></nav><article class="article-preview">${prose}</article><footer><p>Footer noise</p></footer></body>`,
  );
  assert.equal(extractDefenderArticle(html, url), `${first}\n\n${second}`);
});

test("Defender retains headings, linked text, lists and quotes without duplicate nested blocks", () => {
  const html = page(
    `${prose}<h4>A synthetic question?</h4><blockquote><p>A fictional quoted answer with <strong>emphasis</strong>.</p></blockquote><ul><li><p>First synthetic item</p></li><li>Second synthetic item</li></ul><p>See the <a href="https://example.test/">synthetic reference</a>.</p>`,
  );
  assert.equal(
    extractDefenderArticle(html, url),
    `${first}\n\n${second}\n\nA synthetic question?\n\nA fictional quoted answer with emphasis.\n\nFirst synthetic item\n\nSecond synthetic item\n\nSee the synthetic reference.`,
  );
});

test("Defender removes media captions, audio UI, newsletters and related content", () => {
  const noise = [
    "share-wrap",
    "wp-block-thdfndr-audio",
    "single-ml-subscribe-form",
    "related-posts",
    "related-articles",
    "article-preview",
    "advertisement",
    "wp-caption",
  ]
    .map(
      (className) =>
        `<div class="${className}"><p>Unwanted ${className} text</p></div>`,
    )
    .join("");
  const html = page(
    `${noise}${prose}<figure><img alt="Image alternative"><figcaption>Unwanted caption</figcaption></figure><p>Read also: a different story</p><p>Subscribe to receive updates</p>`,
  );
  assert.equal(extractDefenderArticle(html, url), `${first}\n\n${second}`);
});

test("Defender does not read hidden body text or embedded scripts", () => {
  const invisible = [
    "hidden",
    "inert",
    'aria-hidden="true"',
    'class="sr-only"',
    'style="display: none !important;"',
    'style="color:red; visibility:hidden"',
    'style="opacity:0.0;"',
  ]
    .map((attrs) => `<div ${attrs}><p>Invisible fixture content</p></div>`)
    .join("");
  const hiddenTags = ["script", "style", "noscript", "template", "iframe"]
    .map((tag) => `<${tag}><p>Embedded fixture content</p></${tag}>`)
    .join("");
  assert.equal(
    extractDefenderArticle(page(`${invisible}${hiddenTags}${prose}`), url),
    `${first}\n\n${second}`,
  );
  assert.equal(
    extractDefenderArticle(page(`<div hidden>${prose}</div>`), url),
    null,
  );
  assert.equal(
    extractDefenderArticle(
      page(`<div style="opacity:0.2">${prose}</div>`),
      url,
    ),
    `${first}\n\n${second}`,
  );
});

test("Defender rejects unsupported URLs instead of reading a generic page", () => {
  for (const candidate of [
    "https://evil.test/en/2026/09/synthetic-update/",
    "https://thedefender.media.evil.test/en/2026/09/synthetic-update/",
    "https://user:secret@thedefender.media/en/2026/09/synthetic-update/",
    "http://thedefender.media/en/2026/09/synthetic-update/",
    "https://thedefender.media:444/en/2026/09/synthetic-update/",
    "https://thedefender.media/en/",
    "https://thedefender.media/en/insights/",
    "https://thedefender.media/en/2026/09/",
    "https://thedefender.media/en/2026/13/synthetic-update/",
    "https://thedefender.media/en/2026/09/synthetic-update/?preview=true",
    "https://thedefender.media/2026/09/synthetic-update/",
    "not-a-url",
  ])
    assert.equal(extractDefenderArticle(page(), candidate), null, candidate);
});

test("Defender accepts Insights URLs, tracking parameters and normalized trailing slashes", () => {
  const insights = "https://thedefender.media/en/insights/synthetic-analysis/";
  assert.equal(
    extractDefenderArticle(
      page(prose, { head: `<link rel="canonical" href="${insights}">` }),
      insights,
    ),
    `${first}\n\n${second}`,
  );
  assert.equal(
    extractDefenderArticle(
      page(),
      `${url.slice(0, -1)}?utm_source=fixture#top`,
    ),
    `${first}\n\n${second}`,
  );
});

test("Defender rejects inconsistent canonical and Open Graph identity", () => {
  for (const head of [
    '<link rel="canonical" href="/en/2026/09/some-other-article/">',
    '<meta property="og:url" content="https://evil.test/en/2026/09/synthetic-update/">',
    `<link rel="canonical" href="${url}"><meta property="og:url" content="/en/2026/09/different/">`,
    '<link rel="canonical" href="">',
    '<link rel="canonical" href="/en/">',
  ])
    assert.equal(extractDefenderArticle(page(prose, { head }), url), null);
  assert.equal(
    extractDefenderArticle(
      page(prose, {
        head: '<link rel="canonical" href="/en/2026/09/synthetic-update/">',
      }),
      url,
    ),
    `${first}\n\n${second}`,
  );
});

test("Defender rejects explicitly inconsistent page languages", () => {
  for (const options of [
    { lang: "uk" },
    { head: '<meta property="og:locale" content="uk_UA">' },
    { head: '<meta http-equiv="content-language" content="fr">' },
    { bodyAttrs: 'lang="uk"' },
    { sectionAttrs: 'lang="uk-UA"' },
  ])
    assert.equal(extractDefenderArticle(page(prose, options), url), null);
  assert.equal(
    extractDefenderArticle(page(prose, { lang: "", head: "" }), url),
    `${first}\n\n${second}`,
  );
});

test("Defender validates structured identity and language without extracting embedded body text", () => {
  const schema = (value: unknown) =>
    `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
  for (const metadata of [
    {
      "@type": "Article",
      "@id": "https://thedefender.media/en/2026/09/different/#article",
    },
    { "@type": "WebPage", url, inLanguage: "uk" },
  ])
    assert.equal(
      extractDefenderArticle(
        page(prose, { head: schema({ "@graph": [metadata] }) }),
        url,
      ),
      null,
    );
  const head = schema({
    "@graph": [
      {
        "@type": "Article",
        "@id": `${url}#article`,
        inLanguage: "en-US",
        articleBody: "Invisible schema article text",
      },
    ],
  });
  assert.equal(
    extractDefenderArticle(page(prose, { head }), url),
    `${first}\n\n${second}`,
  );
  assert.equal(extractDefenderArticle(page("", { head }), url), null);
});

test("Defender refuses explicitly restricted or paywalled pages", () => {
  for (const className of [
    "paywall",
    "pmpro_content_message",
    "pmpro-body-no-access",
    "subscription-required",
  ]) {
    assert.equal(
      extractDefenderArticle(
        page(prose, { bodyAttrs: `class="${className}"` }),
        url,
      ),
      null,
    );
  }
  for (const free of [false, "false"]) {
    assert.equal(
      extractDefenderArticle(
        page(prose, {
          head: `<script type="application/ld+json">${JSON.stringify({ "@type": "Article", isAccessibleForFree: free })}</script>`,
        }),
        url,
      ),
      null,
    );
  }
  assert.equal(
    extractDefenderArticle(
      page(prose, { bodyAttrs: 'class="pmpro-body-has-access"' }),
      url,
    ),
    `${first}\n\n${second}`,
  );
});

test("Defender returns null for unknown structure, ambiguous bodies and poor text", () => {
  assert.equal(
    extractDefenderArticle(
      `<main><h1>Synthetic title</h1>${prose}</main>`,
      url,
    ),
    null,
  );
  assert.equal(
    extractDefenderArticle(page("<p>A short fixture excerpt.</p>"), url),
    null,
  );
  assert.equal(extractDefenderArticle(page(prose, { title: "" }), url), null);
  assert.equal(
    extractDefenderArticle(
      page(prose).replace(
        "</section>",
        `<div class="blog-post-container"><div class="single-article">${prose}</div></div></section>`,
      ),
      url,
    ),
    null,
  );
  assert.equal(
    extractDefenderArticle(page(`<h2>${first}</h2><h3>${second}</h3>`), url),
    null,
  );
});

test("Defender caps article text at 20000 characters", () => {
  const result = extractDefenderArticle(page(prose.repeat(60)), url);
  assert.ok(result);
  assert.equal(result.length, 20000);
  assert.ok(result.startsWith(first));
});

test("Defender requires at least 400 characters of usable prose", () => {
  const short = "A synthetic word sequence. ".repeat(14).trim();
  assert.ok(short.length >= 300 && short.length < 400);
  assert.equal(extractDefenderArticle(page(`<p>${short}</p>`), url), null);
});
