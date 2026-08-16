import test from "node:test";
import assert from "node:assert/strict";
import { createTranslator } from "../src/i18n/i18n.js";

test("createTranslator resolves a key via the injected getMessage", () => {
  const t = createTranslator({ getMessage: (key) => (key === "greeting" ? "Hello" : "") });
  assert.equal(t("greeting"), "Hello");
});

test("createTranslator forwards substitutions positionally", () => {
  let received = null;
  const t = createTranslator({
    getMessage: (key, substitutions) => {
      received = { key, substitutions };
      return "ok";
    },
  });
  t("log_captionsSent", ["3"]);
  assert.deepEqual(received, { key: "log_captionsSent", substitutions: ["3"] });
});

test("createTranslator falls back to the key itself when the message is missing", () => {
  const t = createTranslator({ getMessage: () => "" });
  assert.equal(t("missingKey"), "missingKey");
});

test("createTranslator tolerates a missing/non-function getMessage (no chrome.i18n available)", () => {
  const t = createTranslator({});
  assert.equal(t("anyKey"), "anyKey");
});
