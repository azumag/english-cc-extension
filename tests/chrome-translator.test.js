import test from "node:test";
import assert from "node:assert/strict";
import { ChromeTranslator, queryTranslatorAvailability } from "../src/translation/chrome-translator.js";

test("initializes once and translates text", async () => {
  let createCalls = 0;
  const statuses = [];
  const globalScope = {
    Translator: {
      async availability() { return "available"; },
      async create() {
        createCalls += 1;
        return { async translate(text) { return `EN:${text}`; } };
      },
    },
  };
  const translator = new ChromeTranslator({ globalScope, onStatus: (status) => statuses.push(status.state) });
  assert.equal(await translator.availability(), "available");
  assert.equal(await translator.translate("こんにちは"), "EN:こんにちは");
  assert.equal(await translator.translate("世界"), "EN:世界");
  assert.equal(createCalls, 1);
  assert.deepEqual(statuses, ["initializing", "ready"]);
});

test("fails closed when the Translator API is unavailable", async () => {
  const translator = new ChromeTranslator({ globalScope: {} });
  assert.equal(translator.supported, false);
  await assert.rejects(() => translator.translate("test"), /unavailable/);
});

test("queryTranslatorAvailability reports unavailable when Translator.create is missing", async () => {
  assert.equal(await queryTranslatorAvailability({}, { sourceLanguage: "ja", targetLanguage: "en" }), "unavailable");
});

test("queryTranslatorAvailability reports unknown when availability() itself is missing", async () => {
  const globalScope = { Translator: { async create() { return {}; } } };
  assert.equal(await queryTranslatorAvailability(globalScope, { sourceLanguage: "ja", targetLanguage: "en" }), "unknown");
});

test("queryTranslatorAvailability forwards the source/target pair to Translator.availability", async () => {
  let received = null;
  const globalScope = {
    Translator: {
      async create() { return {}; },
      async availability(pair) { received = pair; return "downloadable"; },
    },
  };
  const result = await queryTranslatorAvailability(globalScope, { sourceLanguage: "ja", targetLanguage: "fr" });
  assert.equal(result, "downloadable");
  assert.deepEqual(received, { sourceLanguage: "ja", targetLanguage: "fr" });
});
