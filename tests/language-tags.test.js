import test from "node:test";
import assert from "node:assert/strict";
import { targetAllowsCjkText, toTranslatorLanguageTag } from "../src/translation/language-tags.js";

test("maps recognition locales to Translator API language tags", () => {
  assert.equal(toTranslatorLanguageTag("ja-JP"), "ja");
  assert.equal(toTranslatorLanguageTag("en-US"), "en");
  assert.equal(toTranslatorLanguageTag("pt_BR"), "pt");
  assert.equal(toTranslatorLanguageTag("zh-CN"), "zh");
  assert.equal(toTranslatorLanguageTag("zh-TW"), "zh-Hant");
  assert.equal(toTranslatorLanguageTag("zh-Hant"), "zh-Hant");
});

test("allows CJK output only for Japanese and Chinese targets", () => {
  assert.equal(targetAllowsCjkText("ja"), true);
  assert.equal(targetAllowsCjkText("zh-TW"), true);
  assert.equal(targetAllowsCjkText("zh-Hant"), true);
  assert.equal(targetAllowsCjkText("en"), false);
  assert.equal(targetAllowsCjkText("ko"), false);
});
