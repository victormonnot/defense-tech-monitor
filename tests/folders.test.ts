import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FOLDER_NAME_LENGTH, parseFolderName } from "../src/lib/folders";

test("folder names preserve display case while normalizing Unicode and spacing for identity", () => {
  assert.deepEqual(parseFolderName("  Ae\u0301rien   et\u00a0robotique  "), {
    name: "Aérien et robotique",
    key: "aérien et robotique",
  });
  assert.equal(
    parseFolderName("AÉRIEN et ROBOTIQUE").key,
    parseFolderName("Aérien et robotique").key,
  );
  assert.notEqual(parseFolderName("Aérien").key, parseFolderName("Aerien").key);
  assert.equal(
    parseFolderName("🛰️ Satellites / 2026").name,
    "🛰️ Satellites / 2026",
  );
});

test("folder names reject empty, oversized and control-character input", () => {
  for (const value of [
    undefined,
    null,
    {},
    1,
    [],
    "",
    " \u00a0 ",
    "a".repeat(MAX_FOLDER_NAME_LENGTH + 1),
    "Line\nbreak",
    "Tab\tname",
    "Null\0byte",
    "Delete\x7f",
    "Control\u0085name",
  ]) {
    assert.throws(() => parseFolderName(value));
  }
  assert.equal(
    parseFolderName("a".repeat(MAX_FOLDER_NAME_LENGTH)).name.length,
    MAX_FOLDER_NAME_LENGTH,
  );
});
