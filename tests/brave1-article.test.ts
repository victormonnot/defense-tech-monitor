import assert from "node:assert/strict";
import test from "node:test";
import { extractBrave1Article } from "../src/lib/connectors/brave1-article";

// Synthetic editorial text and publisher structures, without real article copies.
const url = "https://brave1.gov.ua/en/news/fixture-research";
const paragraph =
  "The research team has published a detailed account of its latest work. Engineers are testing new components with independent partners and comparing the results from several trials. The project will use these findings to improve reliability and document the remaining limitations for future development. The published methodology also explains how each measurement was recorded and how the team checked the consistency of its observations.";
const content = (text = paragraph) =>
  `<div class="content html text-break"><p>${text}</p></div>`;
const page = (body = content(), head = "", language = "uk") =>
  `<html lang="${language}"><head>${head}</head><body><nav>Navigation links</nav><app-news-view><main><app-news-view-hero><h1>Fixture research report</h1></app-news-view-hero><section class="main__content">${body}</section><section class="related-articles">Other publications</section></main></app-news-view><footer>Site footer</footer></body></html>`;

test("Brave1 extracts only visible editorial blocks despite its incorrect root language", () => {
  assert.equal(extractBrave1Article(page(), url), paragraph);
  assert.equal(
    extractBrave1Article(page(undefined, undefined, "en-GB"), url),
    paragraph,
  );
});

test("Brave1 keeps rich text, numbered lists and attributed quotes in article order", () => {
  const markup =
    content() +
    '<div class="content"><app-numbered-list><div><h4>Research steps</h4><ol><li>First fixture step.</li><li>Second fixture step.</li></ol></div></app-numbered-list></div>' +
    '<div class="content html highlight"><p>Highlighted result.</p></div>' +
    '<div class="content"><app-quote-block><div><blockquote><p>A synthetic quotation from the researcher.</p><cite><span>Fixture Author</span><span>Researcher</span></cite></blockquote></div></app-quote-block></div>' +
    content("The final &amp; verified <strong>finding</strong>.");
  const text = extractBrave1Article(page(markup), url);
  assert.equal(
    text,
    `${paragraph} Research steps First fixture step. Second fixture step. Highlighted result. A synthetic quotation from the researcher. Fixture Author Researcher The final & verified finding.`,
  );
});

test("Brave1 excludes scripts, templates, hidden text, captions and interface components", () => {
  const markup = content(
    paragraph +
      '<script>secretScript()</script><style>.secret{}</style><noscript>Hidden fallback</noscript><template>Hidden template</template><iframe>Hidden frame</iframe><span hidden>Hidden attribute</span><span inert>Inert text</span><span aria-hidden="true">ARIA hidden</span><span class="d-none">Hidden class</span><span style="color:red; display: none !important">Inline hidden</span><span style="visibility:hidden">Invisible text</span><span style="content-visibility: hidden">Hidden content</span><figure><img alt="Image description"><figcaption>Photo caption</figcaption></figure><p class="image-caption">Image caption</p><aside>Other story</aside><nav>Menu</nav><form>Newsletter form</form><div class="share">Share this</div><div class="newsletter">Subscribe</div><app-news-cards-list>Related cards</app-news-cards-list>',
  );
  assert.equal(extractBrave1Article(page(markup), url), paragraph);
});

test("Brave1 requires the official HTTPS English article URL", () => {
  for (const invalid of [
    "https://elsewhere.example/en/news/fixture-research",
    "http://brave1.gov.ua/en/news/fixture-research",
    "https://brave1.gov.ua/en/news",
    "https://brave1.gov.ua/news/fixture-research",
    "https://brave1.gov.ua/en/news/fixture-research/photo.jpg",
    "https://brave1.gov.ua/en/news/langPrefix/news/fixture-research",
    "https://user:password@brave1.gov.ua/en/news/fixture-research",
    "javascript:alert(1)",
    "not-a-url",
  ])
    assert.equal(extractBrave1Article(page(), invalid), null);
});

test("Brave1 checks canonical and Open Graph article identity and refuses HTML redirects", () => {
  const valid =
    '<link rel="canonical" href="/en/news/fixture-research/"><meta property="og:url" content="https://brave1.gov.ua/en/news/fixture-research">';
  assert.equal(
    extractBrave1Article(
      page(undefined, valid),
      `${url}?utm_source=fixture#article`,
    ),
    paragraph,
  );
  for (const meta of [
    '<link rel="canonical" href="https://elsewhere.example/en/news/fixture-research">',
    '<link rel="canonical" href="/en/news/other-article">',
    '<meta property="og:url" content="https://brave1.gov.ua/news/fixture-research">',
    '<meta http-equiv="REFRESH" content="0;url=/en">',
  ])
    assert.equal(extractBrave1Article(page(undefined, meta), url), null);
});

test("Brave1 rejects explicit conflicting languages and predominantly non-English article text", () => {
  assert.equal(
    extractBrave1Article(page(undefined, undefined, "fr"), url),
    null,
  );
  assert.equal(
    extractBrave1Article(page().replace("<body>", '<body lang="uk">'), url),
    null,
  );
  assert.equal(
    extractBrave1Article(
      page(content().replace('class="content', 'lang="uk" class="content')),
      url,
    ),
    null,
  );
  for (const meta of [
    '<meta property="og:locale" content="uk_UA">',
    '<meta http-equiv="Content-Language" content="uk">',
  ]) {
    assert.equal(extractBrave1Article(page(undefined, meta), url), null);
  }
  assert.equal(
    extractBrave1Article(
      page(
        content(
          "Це синтетичний текст для перевірки мови сторінки. ".repeat(20),
        ),
      ),
      url,
    ),
    null,
  );
  assert.equal(
    extractBrave1Article(
      page(
        content(
          "Bonjour les chercheurs présentent leurs expériences scientifiques et plusieurs observations détaillées. ".repeat(
            12,
          ),
        ),
      ),
      url,
    ),
    null,
  );
});

test("Brave1 returns null for insufficient, ambiguous or unrecognized editorial structures", () => {
  for (const html of [
    "<html><body>Access denied</body></html>",
    page(content("Only a short teaser.")),
    page("").replace("</main>", `${content()}</main>`),
    page().replaceAll("app-news-view-hero", "new-hero"),
    page().replaceAll("main__content", "new-body"),
    page(content().replace("content html", "new-content html")),
    page(
      content() +
        '<div class="content"><app-unknown-block>Unknown editorial text</app-unknown-block></div>',
    ),
    page() + page(),
    page(content()).replace("<app-news-view>", "<app-news-view hidden>"),
  ])
    assert.equal(extractBrave1Article(html, url), null);
});

test("Brave1 never treats gated content as an available article", () => {
  for (const gate of [
    '<div class="paywall">Subscribe to read</div>',
    '<div data-paywall="true">Members only</div>',
  ]) {
    assert.equal(extractBrave1Article(page(content() + gate), url), null);
  }
  assert.equal(
    extractBrave1Article(
      page(
        content("Short visible preview.") + `<div hidden>${content()}</div>`,
      ),
      url,
    ),
    null,
  );
});

test("Brave1 bounds article text to twenty thousand characters", () => {
  const text = extractBrave1Article(page(content(paragraph.repeat(100))), url);
  assert.ok(text);
  assert.ok(text.length <= 20_000);
  assert.ok(text.length > 19_900);
});

test("Brave1 requires at least four hundred available characters", () => {
  assert.equal(
    extractBrave1Article(page(content(paragraph.slice(0, 399))), url),
    null,
  );
  assert.equal(
    extractBrave1Article(page(content(paragraph.slice(0, 400))), url),
    paragraph.slice(0, 400),
  );
});
