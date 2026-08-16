import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

test("manifest uses a minimal permission set", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["sidePanel", "storage"]);
  assert.equal(manifest.permissions.includes("tabs"), false);
  assert.equal(manifest.permissions.includes("cookies"), false);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*", "http://localhost/*"]);
});

test("manifest entry points exist", async () => {
  const paths = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
  ];
  for (const path of paths) {
    await access(new URL(`../${path}`, import.meta.url));
  }
});

// chrome.i18n needs no extra permission (see manifest permissions test
// above, which is unaffected), but default_locale + a matching messages.json
// are both required or the whole extension fails to load.
test("manifest declares a default_locale backed by a messages.json", async () => {
  assert.equal(typeof manifest.default_locale, "string");
  assert.ok(manifest.default_locale.length > 0);
  const messagesPath = `_locales/${manifest.default_locale}/messages.json`;
  await access(new URL(`../${messagesPath}`, import.meta.url));
  const messages = JSON.parse(await readFile(new URL(`../${messagesPath}`, import.meta.url), "utf8"));
  assert.ok(messages.extName?.message, "extName message missing");
});

test("every __MSG_x__ reference in manifest.json resolves in the default locale", async () => {
  const messages = JSON.parse(
    await readFile(new URL(`../_locales/${manifest.default_locale}/messages.json`, import.meta.url), "utf8"));
  const manifestText = await readFile(new URL("../manifest.json", import.meta.url), "utf8");
  const referenced = [...manifestText.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)].map((match) => match[1]);
  assert.ok(referenced.length > 0, "expected at least one __MSG_x__ reference in manifest.json");
  for (const key of referenced) {
    assert.ok(messages[key]?.message, `manifest references __MSG_${key}__ but _locales/${manifest.default_locale}/messages.json has no such key`);
  }
});
