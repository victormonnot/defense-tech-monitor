import assert from "node:assert/strict";
import test from "node:test";
import { classificationText, parseProfile } from "../src/lib/profile";

const profile = { keywords: ["drone"], excludeKeywords: [], minScore: 1 };

test("legacy profiles preserve full-text selection and both explicit scopes are valid", () => {
  assert.deepEqual(parseProfile(profile), profile);
  for (const matchScope of ["all_text", "title_excerpt"] as const)
    assert.deepEqual(parseProfile({ ...profile, matchScope }), {
      ...profile,
      matchScope,
    });
  assert.deepEqual(
    parseProfile({ ...profile, keywords: [" drone ", "drone"] }).keywords,
    ["drone"],
  );
});

test("saved profiles and previews reject invalid scopes, thresholds and keyword inputs", () => {
  for (const matchScope of [null, "title", "", 1, {}])
    assert.throws(() => parseProfile({ ...profile, matchScope }), /Périmètre/);
  for (const minScore of [0, 21, 1.5, "2", null, NaN])
    assert.throws(() => parseProfile({ ...profile, minScore }), /seuil/);
  for (const keywords of [
    null,
    "drone",
    [""],
    [null],
    ["a".repeat(101)],
    Array(101).fill("drone"),
  ])
    assert.throws(() => parseProfile({ ...profile, keywords }));
  assert.throws(() => parseProfile([]), /Profil/);
  assert.throws(() => parseProfile(null), /Profil/);
});

test("scope selection uses only supplied content and never fills a missing excerpt from the body", () => {
  const article = {
    title: "Fixture title",
    text: "Full collected text",
    excerpt: "Available excerpt",
  };
  assert.equal(
    classificationText(article, profile),
    "Fixture title\nFull collected text",
  );
  assert.equal(
    classificationText(article, { ...profile, matchScope: "title_excerpt" }),
    "Fixture title\nAvailable excerpt",
  );
  assert.equal(
    classificationText(
      { ...article, excerpt: null },
      { ...profile, matchScope: "title_excerpt" },
    ),
    "Fixture title\n",
  );
  assert.equal(
    classificationText({ ...article, text: "", excerpt: null }, profile),
    "Fixture title\n",
  );
});
