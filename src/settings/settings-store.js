import { DEFAULT_SETTINGS, normalizeSettings } from "../shared/contracts.js";

const SETTINGS_KEY = "englishCcSettings";
const OBS_PASSWORD_KEY = "obsPassword";
let memoryPassword = "";

function requireChromeStorage() {
  if (!globalThis.chrome?.storage?.local) {
    throw new Error("chrome.storage is unavailable");
  }
}

export async function loadSettings() {
  requireChromeStorage();
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings({ ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] ?? {}) });
}

export async function saveSettings(settings) {
  requireChromeStorage();
  const normalized = normalizeSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}

// session storage is always the live value for the running Chrome session,
// regardless of persistLocal. chrome.storage.local only ever mirrors it when
// the user has explicitly opted in (persistLocal: true) so the password
// survives a Chrome restart — see the security invariants in
// docs/HANDOFF.md 6. saveObsPassword() keeps that mirror in sync: it writes
// the local copy when opting in and removes it as soon as the user opts
// back out, so an OFF -> ON -> OFF cycle never leaves a stray copy on disk.
export async function loadObsPassword() {
  if (globalThis.chrome?.storage?.session) {
    const stored = await chrome.storage.session.get(OBS_PASSWORD_KEY);
    const sessionValue = String(stored[OBS_PASSWORD_KEY] ?? "");
    if (sessionValue) return sessionValue;

    // Session storage is empty, most likely because Chrome was restarted.
    // Fall back to the opt-in local mirror, if any, and warm the session
    // cache so the rest of this session reads it from there.
    if (globalThis.chrome?.storage?.local) {
      const storedLocal = await chrome.storage.local.get(OBS_PASSWORD_KEY);
      const localValue = String(storedLocal[OBS_PASSWORD_KEY] ?? "");
      if (localValue) await chrome.storage.session.set({ [OBS_PASSWORD_KEY]: localValue });
      return localValue;
    }
    return "";
  }
  return memoryPassword;
}

export async function saveObsPassword(password, { persistLocal = false } = {}) {
  const value = String(password ?? "");
  if (globalThis.chrome?.storage?.session) {
    await chrome.storage.session.set({ [OBS_PASSWORD_KEY]: value });
  } else {
    memoryPassword = value;
  }

  if (globalThis.chrome?.storage?.local) {
    // An empty password always removes the local mirror, even with
    // persistLocal: true — there is nothing worth persisting, and leaving a
    // stray `obsPassword: ""` key on disk would undercut the "opting out
    // leaves zero residue" guarantee below.
    if (persistLocal && value) {
      await chrome.storage.local.set({ [OBS_PASSWORD_KEY]: value });
    } else {
      await chrome.storage.local.remove(OBS_PASSWORD_KEY);
    }
  }
}

// Removes only the opt-in local mirror, e.g. right when the user unchecks
// "save on this device" — the session copy (this run's live password) is
// left untouched.
export async function removeLocalObsPassword() {
  if (globalThis.chrome?.storage?.local) {
    await chrome.storage.local.remove(OBS_PASSWORD_KEY);
  }
}

export async function clearObsPassword() {
  if (globalThis.chrome?.storage?.session) {
    await chrome.storage.session.remove(OBS_PASSWORD_KEY);
  }
  await removeLocalObsPassword();
  memoryPassword = "";
}
