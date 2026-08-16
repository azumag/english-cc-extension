import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const LOCALES = ["en", "ja"];

async function loadMessages(locale) {
  const raw = await readFile(new URL(`../_locales/${locale}/messages.json`, import.meta.url), "utf8");
  return JSON.parse(raw);
}

async function collectSourceFiles(dir) {
  const files = [];
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const fullPath = join(dir, name.name);
    if (name.isDirectory()) files.push(...await collectSourceFiles(fullPath));
    else if (fullPath.endsWith(".js") || fullPath.endsWith(".html")) files.push(fullPath);
  }
  return files;
}

// Any identifier shaped like one of our i18n key prefixes, wherever it
// appears (data-i18n* attribute values, t("key") call sites, or the
// {key: "..."} message descriptors in src/permission/mic-permission-flow.js).
// Intentionally broad rather than trying to parse call sites precisely —
// a stray match just has to resolve in both catalogs below, which any real
// key does.
const KEY_PATTERN = /\b(?:ui|status|err|log|pair|micHelper)_[A-Za-z0-9]+\b/g;

test("en and ja message catalogs declare exactly the same keys", async () => {
  const [en, ja] = await Promise.all(LOCALES.map(loadMessages));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ja).sort());
});

test("every message has non-empty text in both locales", async () => {
  const [en, ja] = await Promise.all(LOCALES.map(loadMessages));
  for (const [locale, catalog] of [["en", en], ["ja", ja]]) {
    for (const [key, entry] of Object.entries(catalog)) {
      assert.ok(typeof entry.message === "string" && entry.message.length > 0, `${locale}/${key} has no message text`);
    }
  }
});

test("placeholder names for a given key match between en and ja", async () => {
  const [en, ja] = await Promise.all(LOCALES.map(loadMessages));
  for (const key of Object.keys(en)) {
    const enNames = Object.keys(en[key].placeholders ?? {}).sort();
    const jaNames = Object.keys(ja[key].placeholders ?? {}).sort();
    assert.deepEqual(enNames, jaNames, `placeholder mismatch for key "${key}"`);
  }
});

test("every $NAME$ token in a message resolves to a declared placeholder", async () => {
  const [en, ja] = await Promise.all(LOCALES.map(loadMessages));
  for (const [locale, catalog] of [["en", en], ["ja", ja]]) {
    for (const [key, entry] of Object.entries(catalog)) {
      const tokens = [...entry.message.matchAll(/\$([A-Z][A-Z0-9]*)\$/g)].map((m) => m[1].toLowerCase());
      const declared = new Set(Object.keys(entry.placeholders ?? {}));
      for (const token of tokens) {
        assert.ok(declared.has(token), `${locale}/${key} uses $${token.toUpperCase()}$ without declaring a "${token}" placeholder`);
      }
    }
  }
});

test("every i18n key referenced under src/ resolves in both locale catalogs", async () => {
  const [en, ja] = await Promise.all(LOCALES.map(loadMessages));
  const files = await collectSourceFiles(new URL("../src", import.meta.url).pathname);
  const referenced = new Set();
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(KEY_PATTERN)) referenced.add(match[0]);
  }
  assert.ok(referenced.size > 0, "expected to find at least one i18n key reference under src/");
  for (const key of referenced) {
    assert.ok(en[key]?.message, `"${key}" is referenced under src/ but missing from _locales/en/messages.json`);
    assert.ok(ja[key]?.message, `"${key}" is referenced under src/ but missing from _locales/ja/messages.json`);
  }
});
