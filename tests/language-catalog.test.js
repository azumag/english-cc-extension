import test from "node:test";
import assert from "node:assert/strict";
import {
  CUSTOM_LANGUAGE_VALUE,
  pairAvailabilityMessageKey,
  readLanguageControl,
  recognitionLanguageOptions,
  resolveSelectValue,
  swapLanguagePair,
  targetLanguageOptions,
} from "../src/translation/language-catalog.js";

test("recognitionLanguageOptions and targetLanguageOptions list non-empty, unique values", () => {
  const recognition = recognitionLanguageOptions();
  const target = targetLanguageOptions();
  assert.ok(recognition.length > 0);
  assert.ok(target.length > 0);
  assert.equal(new Set(recognition.map((o) => o.value)).size, recognition.length);
  assert.equal(new Set(target.map((o) => o.value)).size, target.length);
  for (const option of [...recognition, ...target]) {
    assert.equal(typeof option.value, "string");
    assert.equal(typeof option.label, "string");
    assert.ok(option.value.length > 0);
    assert.ok(option.label.length > 0);
  }
});

test("targetLanguageOptions includes the defaults referenced elsewhere in the app", () => {
  const values = targetLanguageOptions().map((o) => o.value);
  assert.ok(values.includes("en"));
  assert.ok(values.includes("ja"));
  assert.ok(values.includes("zh-Hant"));
});

test("resolveSelectValue matches a cataloged value case-insensitively", () => {
  const options = targetLanguageOptions();
  assert.deepEqual(resolveSelectValue("EN", options), { selectValue: "en", customValue: "" });
  assert.deepEqual(resolveSelectValue("en", options), { selectValue: "en", customValue: "" });
});

test("resolveSelectValue falls back to custom for a value outside the catalog, never dropping it", () => {
  const options = targetLanguageOptions();
  assert.deepEqual(resolveSelectValue("nl", options), { selectValue: CUSTOM_LANGUAGE_VALUE, customValue: "nl" });
});

test("resolveSelectValue falls back to custom (empty) for an empty stored value", () => {
  const options = targetLanguageOptions();
  assert.deepEqual(resolveSelectValue("", options), { selectValue: CUSTOM_LANGUAGE_VALUE, customValue: "" });
  assert.deepEqual(resolveSelectValue(undefined, options), { selectValue: CUSTOM_LANGUAGE_VALUE, customValue: "" });
});

test("readLanguageControl reads the select value unless it's the custom sentinel", () => {
  assert.equal(readLanguageControl({ selectValue: "en", customValue: "ignored" }), "en");
  assert.equal(readLanguageControl({ selectValue: CUSTOM_LANGUAGE_VALUE, customValue: "  nl  " }), "nl");
});

test("swapLanguagePair swaps a cataloged pair round-trip-safely", () => {
  const swapped = swapLanguagePair({ recognitionLanguage: "ja-JP", targetLanguage: "en" });
  assert.deepEqual(swapped, { recognitionLanguage: "en-US", targetLanguage: "ja" });
  const swappedBack = swapLanguagePair(swapped);
  assert.deepEqual(swappedBack, { recognitionLanguage: "ja-JP", targetLanguage: "en" });
});

test("swapLanguagePair is lossy but safe for a recognition locale with multiple variants", () => {
  // en-GB has no dedicated Translator tag distinct from en-US, so swapping
  // twice can normalize en-GB -> en-US. This is a known, documented
  // trade-off (see src/translation/language-catalog.js) rather than a bug.
  const swapped = swapLanguagePair({ recognitionLanguage: "en-GB", targetLanguage: "ja" });
  assert.deepEqual(swapped, { recognitionLanguage: "ja-JP", targetLanguage: "en" });
});

test("swapLanguagePair falls back to using the target tag as the new locale when uncataloged", () => {
  const swapped = swapLanguagePair({ recognitionLanguage: "ja-JP", targetLanguage: "nl" });
  assert.deepEqual(swapped, { recognitionLanguage: "nl", targetLanguage: "ja" });
});

test("pairAvailabilityMessageKey maps known states and falls back to unknown", () => {
  assert.equal(pairAvailabilityMessageKey("same-language"), "pair_sameLanguage");
  assert.equal(pairAvailabilityMessageKey("available"), "pair_available");
  assert.equal(pairAvailabilityMessageKey("downloadable"), "pair_downloadable");
  assert.equal(pairAvailabilityMessageKey("downloading"), "pair_downloading");
  assert.equal(pairAvailabilityMessageKey("unavailable"), "pair_unavailable");
  assert.equal(pairAvailabilityMessageKey("unknown"), "pair_unknown");
  assert.equal(pairAvailabilityMessageKey("something-new"), "pair_unknown");
});
