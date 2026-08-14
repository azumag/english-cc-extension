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

export async function loadObsPassword() {
  if (globalThis.chrome?.storage?.session) {
    const stored = await chrome.storage.session.get(OBS_PASSWORD_KEY);
    return String(stored[OBS_PASSWORD_KEY] ?? "");
  }
  return memoryPassword;
}

export async function saveObsPassword(password) {
  const value = String(password ?? "");
  if (globalThis.chrome?.storage?.session) {
    await chrome.storage.session.set({ [OBS_PASSWORD_KEY]: value });
  } else {
    memoryPassword = value;
  }
}

export async function clearObsPassword() {
  if (globalThis.chrome?.storage?.session) {
    await chrome.storage.session.remove(OBS_PASSWORD_KEY);
  }
  memoryPassword = "";
}
