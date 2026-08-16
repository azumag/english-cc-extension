import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/shared/contracts.js";

test("recognitionQuality defaults to conversation and rejects unknown values", () => {
  assert.equal(DEFAULT_SETTINGS.recognitionQuality, "conversation");
  assert.equal(normalizeSettings({}).recognitionQuality, "conversation");
  assert.equal(normalizeSettings({ recognitionQuality: "dictation" }).recognitionQuality, "dictation");
  assert.equal(normalizeSettings({ recognitionQuality: "command" }).recognitionQuality, "command");
  assert.equal(normalizeSettings({ recognitionQuality: "bogus" }).recognitionQuality, "conversation");
});

test("unspokenPunctuation defaults to true and normalizes to boolean", () => {
  assert.equal(DEFAULT_SETTINGS.unspokenPunctuation, true);
  assert.equal(normalizeSettings({}).unspokenPunctuation, true);
  assert.equal(normalizeSettings({ unspokenPunctuation: false }).unspokenPunctuation, false);
});
