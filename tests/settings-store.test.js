import test from "node:test";
import assert from "node:assert/strict";
import {
  clearObsPassword,
  loadObsPassword,
  loadSettings,
  removeLocalObsPassword,
  saveObsPassword,
  saveSettings,
} from "../src/settings/settings-store.js";

// Minimal in-memory stand-in for a chrome.storage.StorageArea. Real chrome
// APIs also accept array/object forms of get()/remove(), but this codebase
// only ever calls them with a single string key.
function fakeStorageArea() {
  const data = new Map();
  return {
    async get(key) {
      return data.has(key) ? { [key]: data.get(key) } : {};
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
    has: (key) => data.has(key),
    peek: (key) => data.get(key),
  };
}

function installFakeChrome({ session = fakeStorageArea(), local = fakeStorageArea() } = {}) {
  globalThis.chrome = { storage: { session, local } };
  return { session, local };
}

test.afterEach(async () => {
  await clearObsPassword();
  delete globalThis.chrome;
});

test("default (persistLocal not set): password lives in session only", async () => {
  const { session, local } = installFakeChrome();
  await saveObsPassword("hunter2");

  assert.equal(await loadObsPassword(), "hunter2");
  assert.equal(session.peek("obsPassword"), "hunter2");
  assert.equal(local.has("obsPassword"), false);
});

test("persistLocal: true mirrors the password into chrome.storage.local", async () => {
  const { session, local } = installFakeChrome();
  await saveObsPassword("hunter2", { persistLocal: true });

  assert.equal(session.peek("obsPassword"), "hunter2");
  assert.equal(local.peek("obsPassword"), "hunter2");
});

test("turning persistLocal back off removes the local mirror (no OFF->ON->OFF residue)", async () => {
  const { local } = installFakeChrome();
  await saveObsPassword("hunter2", { persistLocal: true });
  assert.equal(local.has("obsPassword"), true);

  await saveObsPassword("hunter2", { persistLocal: false });
  assert.equal(local.has("obsPassword"), false);
});

test("updating the password while opted in overwrites both session and the local mirror", async () => {
  const { session, local } = installFakeChrome();
  await saveObsPassword("hunter2", { persistLocal: true });

  await saveObsPassword("swordfish", { persistLocal: true });

  assert.equal(session.peek("obsPassword"), "swordfish");
  assert.equal(local.peek("obsPassword"), "swordfish");
});

test("saving an empty password never leaves a stray local key, even with persistLocal: true", async () => {
  const { session, local } = installFakeChrome();
  await saveObsPassword("hunter2", { persistLocal: true });

  await saveObsPassword("", { persistLocal: true });

  assert.equal(session.peek("obsPassword"), "");
  assert.equal(local.has("obsPassword"), false);
  assert.equal(await loadObsPassword(), "");
});

test("session is authoritative while it holds a value: a stale local mirror is never read", async () => {
  const { session, local } = installFakeChrome();
  await session.set({ obsPassword: "current-session-value" });
  await local.set({ obsPassword: "stale-local-value" });

  assert.equal(await loadObsPassword(), "current-session-value");
});

test("after a simulated Chrome restart, an opted-in password is restored from local and re-warms session", async () => {
  const { session, local } = installFakeChrome();
  await saveObsPassword("hunter2", { persistLocal: true });

  // Simulate a Chrome restart: chrome.storage.session is cleared, local survives.
  installFakeChrome({ session: fakeStorageArea(), local });

  const restored = await loadObsPassword();
  assert.equal(restored, "hunter2");
  assert.equal(globalThis.chrome.storage.session.peek("obsPassword"), "hunter2");
});

test("without persistLocal, a simulated restart loses the password (unchanged default behavior)", async () => {
  installFakeChrome();
  await saveObsPassword("hunter2");

  installFakeChrome({ session: fakeStorageArea(), local: fakeStorageArea() });
  assert.equal(await loadObsPassword(), "");
});

test("clearObsPassword() wipes session, local, and memory", async () => {
  const { session, local } = installFakeChrome();
  await saveObsPassword("hunter2", { persistLocal: true });

  await clearObsPassword();

  assert.equal(session.has("obsPassword"), false);
  assert.equal(local.has("obsPassword"), false);
  assert.equal(await loadObsPassword(), "");
});

test("removeLocalObsPassword() clears only the local mirror, session is untouched", async () => {
  const { session, local } = installFakeChrome();
  await saveObsPassword("hunter2", { persistLocal: true });

  await removeLocalObsPassword();

  assert.equal(local.has("obsPassword"), false);
  assert.equal(session.peek("obsPassword"), "hunter2");
});

test("falls back to an in-memory password when chrome.storage is unavailable", async () => {
  delete globalThis.chrome;
  await saveObsPassword("hunter2", { persistLocal: true }); // persistLocal is a no-op without chrome.storage
  assert.equal(await loadObsPassword(), "hunter2");
});

test("saveSettings/loadSettings round-trip obsPasswordPersistLocal, defaulting old records to false", async () => {
  const { local } = installFakeChrome();
  await local.set({ englishCcSettings: { recognitionLanguage: "ja-JP" } }); // pre-existing settings, no such key

  const loaded = await loadSettings();
  assert.equal(loaded.obsPasswordPersistLocal, false);

  const saved = await saveSettings({ ...loaded, obsPasswordPersistLocal: true });
  assert.equal(saved.obsPasswordPersistLocal, true);
  assert.equal((await loadSettings()).obsPasswordPersistLocal, true);
});
