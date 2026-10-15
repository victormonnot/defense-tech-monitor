import assert from "node:assert/strict";
import test from "node:test";
import { createSearchMatcher } from "../src/lib/search";

test("search ignores Latin accents and case in queries and publication text", () => {
  assert.equal(createSearchMatcher("DEFENSE")(["Drone de défense"]), true);
  assert.equal(createSearchMatcher("défense")(["DRONE DE DEFENSE"]), true);
  assert.equal(createSearchMatcher("défense")(["de\u0301fense"]), true);
  assert.equal(createSearchMatcher("de\u0301fense")(["défense"]), true);
});

test("search matches every word regardless of order, spacing or field", () => {
  const matches = createSearchMatcher("  defense\t drone\nfrance  ");
  assert.equal(matches(["Drone de défense", "Source France", null]), true);
  assert.equal(matches(["Drone de défense", "Autre source"]), false);
  assert.equal(matches(["Drone civil", "Source France"]), false);
  assert.equal(createSearchMatcher("drone")(["Des drones autonomes"]), true);
});

test("empty searches and missing fields remain usable", () => {
  for (const query of ["", " \t\n", "\u00a0"]) {
    assert.equal(createSearchMatcher(query)([]), true);
    assert.equal(createSearchMatcher(query)([null, undefined, ""]), true);
  }
  assert.equal(createSearchMatcher("drone")([null, undefined, ""]), false);
  assert.equal(createSearchMatcher("null")([null]), false);
  assert.equal(createSearchMatcher("undefined")([undefined]), false);
});

test("search preserves distinct Cyrillic letters while matching case and Unicode forms", () => {
  assert.equal(createSearchMatcher("УКРАЇНА")(["Україна"]), true);
  assert.equal(createSearchMatcher("Украі\u0308на")(["Україна"]), true);
  assert.equal(createSearchMatcher("Украина")(["Україна"]), false);
  assert.equal(createSearchMatcher("Украіна")(["Україна"]), false);
  assert.equal(createSearchMatcher("бойовий")(["БОЙОВИЙ"]), true);
  assert.equal(createSearchMatcher("боиовии")(["бойовий"]), false);
});
