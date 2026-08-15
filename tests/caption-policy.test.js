import test from "node:test";
import assert from "node:assert/strict";
import {
  CaptionPolicy,
  applyCaptionReplacements,
  containsJapaneseText,
  normalizeCaptionText,
  segmentCaptionText,
} from "../src/captions/caption-policy.js";

test("normalizes punctuation and whitespace", () => {
  assert.equal(normalizeCaptionText("  “Hello”  —  world…  "), '"Hello" - world...');
});

test("detects Japanese text", () => {
  assert.equal(containsJapaneseText("Today is Friday."), false);
  assert.equal(containsJapaneseText("今日は Friday."), true);
});

test("applies longest replacements first", () => {
  assert.equal(
    applyCaptionReplacements("Palantia and Pal", { Pal: "P", Palantia: "Palantir" }),
    "Palantir and P",
  );
});

test("segments captions at word boundaries", () => {
  assert.deepEqual(segmentCaptionText("one two three four", 9), ["one two", "three", "four"]);
});

test("rejects expired, Japanese, and duplicate captions", () => {
  let now = 10_000;
  const policy = new CaptionPolicy({ maxAgeMs: 5000, maxCaptionChars: 50, clock: () => now });
  assert.equal(policy.prepare({ text: "old", createdAt: 0 }).reason, "expired");
  assert.equal(policy.prepare({ text: "今日は晴れです", createdAt: now }).reason, "contains-japanese");
  const prepared = policy.prepare({ text: "Today is sunny.", createdAt: now });
  assert.equal(prepared.ok, true);
  policy.markSent(prepared.canonicalText);
  assert.equal(policy.prepare({ text: "Today is sunny.", createdAt: now }).reason, "duplicate");
});

test("allows Japanese and Chinese output for CJK translation targets", () => {
  const policy = new CaptionPolicy({ allowCjkText: true, maxCaptionChars: 50 });
  assert.equal(policy.prepare({ text: "今日は晴れです" }).ok, true);
  assert.equal(policy.prepare({ text: "今天天气很好" }).ok, true);
});
