import test from "node:test";
import assert from "node:assert/strict";
import { cleanTranscript } from "../src/speech/transcript-cleaner.js";

test("normalizes half-width katakana and punctuation variants", () => {
  assert.equal(cleanTranscript("ﾊﾛｰ、ｺﾝﾆﾁﾊ…"), "ハロー、コンニチハ...");
});

test("applies replacements to correct misheard words at the source", () => {
  assert.equal(
    cleanTranscript("きょうはあずまさんと話しました", { あずま: "Azuma" }),
    "きょうはAzumaさんと話しました",
  );
});

test("collapses whitespace and trims", () => {
  assert.equal(cleanTranscript("  えー  と  "), "えー と");
});

test("returns empty string for blank or non-string input", () => {
  assert.equal(cleanTranscript("   "), "");
  assert.equal(cleanTranscript(null), "");
  assert.equal(cleanTranscript(undefined), "");
});
