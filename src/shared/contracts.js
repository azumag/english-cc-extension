export const DEFAULT_SETTINGS = Object.freeze({
  recognitionLanguage: "ja-JP",
  targetLanguage: "en",
  microphoneDeviceId: "",
  obsHost: "127.0.0.1",
  obsPort: 4455,
  obsMicrophoneInputName: "",
  maxPending: 2,
  maxAgeMs: 5000,
  maxCaptionChars: 72,
  segmentIntervalMs: 1500,
  replacements: {},
  logCaptions: false,
  // Opt-in only: when true, the user has explicitly acknowledged the risk
  // warning and asked to keep the OBS password in chrome.storage.local so
  // it survives a Chrome restart. Defaults to false (session-only), see
  // src/settings/settings-store.js.
  obsPasswordPersistLocal: false,
});

export const LOCAL_OBS_HOSTS = Object.freeze(["127.0.0.1", "localhost"]);

export function normalizeLocalObsHost(value) {
  const host = String(value ?? "").trim().toLowerCase();
  if (!LOCAL_OBS_HOSTS.includes(host)) {
    throw new TypeError("OBS host must be 127.0.0.1 or localhost");
  }
  return host;
}

export function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("OBS port must be an integer from 1 to 65535");
  }
  return port;
}

export function normalizePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function normalizeReplacements(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized = {};
  for (const [from, to] of Object.entries(value)) {
    const key = String(from).trim();
    if (!key) continue;
    normalized[key] = String(to ?? "").trim();
  }
  return normalized;
}

export function normalizeSettings(value = {}) {
  return {
    ...DEFAULT_SETTINGS,
    recognitionLanguage: String(value.recognitionLanguage || DEFAULT_SETTINGS.recognitionLanguage),
    targetLanguage: String(value.targetLanguage || DEFAULT_SETTINGS.targetLanguage),
    microphoneDeviceId: String(value.microphoneDeviceId || ""),
    obsHost: normalizeLocalObsHost(value.obsHost || DEFAULT_SETTINGS.obsHost),
    obsPort: normalizePort(value.obsPort || DEFAULT_SETTINGS.obsPort),
    obsMicrophoneInputName: String(value.obsMicrophoneInputName || "").trim(),
    maxPending: normalizePositiveInteger(value.maxPending, DEFAULT_SETTINGS.maxPending, { min: 1, max: 10 }),
    maxAgeMs: normalizePositiveInteger(value.maxAgeMs, DEFAULT_SETTINGS.maxAgeMs, { min: 500, max: 30000 }),
    maxCaptionChars: normalizePositiveInteger(value.maxCaptionChars, DEFAULT_SETTINGS.maxCaptionChars, { min: 20, max: 200 }),
    // 0 disables pacing (segments send back to back, the pre-CaptionPacer behavior).
    segmentIntervalMs: normalizePositiveInteger(value.segmentIntervalMs, DEFAULT_SETTINGS.segmentIntervalMs, { min: 0, max: 10000 }),
    replacements: normalizeReplacements(value.replacements),
    logCaptions: Boolean(value.logCaptions),
    obsPasswordPersistLocal: Boolean(value.obsPasswordPersistLocal),
  };
}
