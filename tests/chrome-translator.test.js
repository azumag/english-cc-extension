import test from "node:test";
import assert from "node:assert/strict";
import { ChromeTranslator } from "../src/translation/chrome-translator.js";

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
