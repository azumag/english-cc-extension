import { CaptionPacer } from "../captions/caption-pacer.js";
import { CaptionPolicy } from "../captions/caption-policy.js";
import { CaptionQueue } from "../captions/caption-queue.js";
import { ObsCaptionOutput } from "../obs/obs-caption-output.js";
import { ObsWebSocketClient, buildObsWebSocketUrl } from "../obs/obs-websocket-client.js";
import {
  MIC_PERMISSION_CHANNEL,
  awaitHelperCompletion,
  decideMicPermissionAction,
  microphoneStatusKey,
  queryMicrophonePermission,
  shouldOpenHelperAfterFailure,
} from "../permission/mic-permission-flow.js";
import { InterimCommitter } from "../speech/interim-committer.js";
import { SpeechRecognizer } from "../speech/speech-recognizer.js";
import { cleanTranscript } from "../speech/transcript-cleaner.js";
import { ChromeTranslator, queryTranslatorAvailability } from "../translation/chrome-translator.js";
import { targetAllowsCjkText, toTranslatorLanguageTag } from "../translation/language-tags.js";
import {
  CUSTOM_LANGUAGE_VALUE,
  pairAvailabilityMessageKey,
  readLanguageControl,
  recognitionLanguageOptions,
  resolveSelectValue,
  swapLanguagePair,
  targetLanguageOptions,
} from "../translation/language-catalog.js";
import { applyTranslations, createTranslator } from "../i18n/i18n.js";
import { RingLogger } from "../shared/logger.js";
import { normalizeSettings } from "../shared/contracts.js";
import { loadObsPassword, loadSettings, saveObsPassword, saveSettings } from "../settings/settings-store.js";

const t = createTranslator({ getMessage: globalThis.chrome?.i18n?.getMessage?.bind(globalThis.chrome.i18n) });

// Matches the fatal errors SpeechRecognizer stops retrying on
// (see src/speech/speech-recognizer.js FATAL_ERRORS) with a message
// telling the user what manual step unblocks a restart.
const FATAL_ERROR_LABELS = {
  "not-allowed": t("err_fatalNotAllowed"),
  "service-not-allowed": t("err_fatalServiceNotAllowed"),
  "language-not-supported": t("err_fatalLanguageNotSupported"),
};

const elements = Object.fromEntries([
  "overallStatus", "chromeStatus", "microphoneStatus", "recognitionStatus", "translationStatus", "obsStatus", "streamStatus",
  "microphoneSelect", "refreshMicrophonesButton",
  "recognitionLanguageSelect", "recognitionLanguageCustomInput", "targetLanguageSelect", "targetLanguageCustomInput",
  "swapLanguagesButton", "pairAvailability",
  "recognitionQualitySelect", "unspokenPunctuationInput",
  "obsHostInput", "obsPortInput", "obsPasswordInput", "obsPasswordPersistInput", "obsMicrophoneInputName",
  "connectObsButton", "testCaptionButton", "maxPendingInput", "maxAgeInput", "maxCaptionCharsInput", "segmentIntervalInput", "interimFlushCharsInput", "replacementsInput",
  "saveSettingsButton", "interimPreview", "japanesePreview", "englishPreview", "startButton", "stopButton", "clearLogButton", "eventLog",
].map((id) => [id, document.getElementById(id)]));

const state = {
  settings: null,
  translator: null,
  recognizer: null,
  interimCommitter: null,
  obsClient: null,
  output: null,
  pacer: null,
  policy: null,
  queue: null,
  running: false,
  statusTimer: null,
  micHelperWindow: null,
  micPermissionWaiting: false,
};

const logger = new RingLogger({
  onEntry: (_entry, entries) => renderLog(entries),
});

function renderLog(entries) {
  elements.eventLog.replaceChildren(...entries.slice().reverse().map((entry) => {
    const item = document.createElement("li");
    item.className = entry.level;
    item.textContent = `${new Date(entry.at).toLocaleTimeString()} ${entry.message}`;
    return item;
  }));
}

function setOverallStatus(stateName, label) {
  elements.overallStatus.textContent = label;
  elements.overallStatus.className = `status status-${stateName}`;
}

function setText(id, text) {
  elements[id].textContent = text;
}

function parseReplacements() {
  const raw = elements.replacementsInput.value.trim();
  if (!raw) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(t("err_replacementsInvalidJson"));
  }
  return value;
}

// --- Language pickers -------------------------------------------------
// Each <select> is populated from src/translation/language-catalog.js plus
// a trailing "custom" option; picking it reveals the adjacent free-text
// input. See CUSTOM_LANGUAGE_VALUE / resolveSelectValue / readLanguageControl
// there for why a pure escape hatch exists (Chrome may support language
// pairs the catalog doesn't list, and it must never silently drop a saved
// setting that isn't in the catalog).

function populateLanguageSelect(select, options) {
  const customOption = document.createElement("option");
  customOption.value = CUSTOM_LANGUAGE_VALUE;
  customOption.textContent = t("ui_languageCustomOption");
  select.replaceChildren(...options.map((entry) => {
    const option = document.createElement("option");
    option.value = entry.value;
    option.textContent = entry.label;
    return option;
  }), customOption);
}

function toggleCustomInputVisibility(select, customInput) {
  customInput.hidden = select.value !== CUSTOM_LANGUAGE_VALUE;
}

function setLanguageControl(select, customInput, storedValue, options) {
  const resolved = resolveSelectValue(storedValue, options);
  select.value = resolved.selectValue;
  customInput.value = resolved.customValue;
  toggleCustomInputVisibility(select, customInput);
}

function readRecognitionLanguage() {
  return readLanguageControl({
    selectValue: elements.recognitionLanguageSelect.value,
    customValue: elements.recognitionLanguageCustomInput.value,
  });
}

function readTargetLanguage() {
  return readLanguageControl({
    selectValue: elements.targetLanguageSelect.value,
    customValue: elements.targetLanguageCustomInput.value,
  });
}

function setPairAvailability(pairState, text) {
  elements.pairAvailability.dataset.state = pairState;
  elements.pairAvailability.textContent = text;
}

// Advisory only — it never disables the start button. Translator.availability()
// can report "unknown" in some Chrome versions, and startCaptions() keeps its
// own fail-closed check, so this is purely a heads-up before the user commits.
let pairAvailabilityToken = 0;

async function updatePairAvailability() {
  const token = ++pairAvailabilityToken;
  const sourceTag = toTranslatorLanguageTag(readRecognitionLanguage());
  const targetTag = toTranslatorLanguageTag(readTargetLanguage());

  if (!sourceTag || !targetTag) {
    // Distinct from "unknown" below: this is an empty custom-language
    // input, not Chrome being unable to answer the availability query.
    setPairAvailability("incomplete", t("pair_incomplete"));
    return;
  }
  if (sourceTag === targetTag) {
    setPairAvailability("same-language", t(pairAvailabilityMessageKey("same-language")));
    return;
  }

  setPairAvailability("checking", t("pair_checking"));
  let availability;
  try {
    availability = await queryTranslatorAvailability(globalThis, { sourceLanguage: sourceTag, targetLanguage: targetTag });
  } catch {
    availability = "unknown";
  }
  // A newer check already superseded this one (another change landed while
  // this await was in flight) — discard the stale result rather than let it
  // overwrite what the user is now looking at.
  if (token !== pairAvailabilityToken) return;
  setPairAvailability(availability, t(pairAvailabilityMessageKey(availability)));
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
const debouncedUpdatePairAvailability = debounce(() => { void updatePairAvailability(); }, 300);

// --- Settings form ------------------------------------------------------

function readFormSettings() {
  return normalizeSettings({
    recognitionLanguage: readRecognitionLanguage(),
    recognitionQuality: elements.recognitionQualitySelect.value,
    unspokenPunctuation: elements.unspokenPunctuationInput.checked,
    targetLanguage: readTargetLanguage(),
    microphoneDeviceId: elements.microphoneSelect.value,
    obsHost: elements.obsHostInput.value,
    obsPort: Number(elements.obsPortInput.value),
    obsPasswordPersistLocal: elements.obsPasswordPersistInput.checked,
    obsMicrophoneInputName: elements.obsMicrophoneInputName.value,
    maxPending: Number(elements.maxPendingInput.value),
    maxAgeMs: Number(elements.maxAgeInput.value),
    maxCaptionChars: Number(elements.maxCaptionCharsInput.value),
    segmentIntervalMs: Number(elements.segmentIntervalInput.value),
    interimFlushChars: Number(elements.interimFlushCharsInput.value),
    replacements: parseReplacements(),
    logCaptions: false,
  });
}

function populateSettings(settings) {
  setLanguageControl(elements.recognitionLanguageSelect, elements.recognitionLanguageCustomInput, settings.recognitionLanguage, recognitionLanguageOptions());
  setLanguageControl(elements.targetLanguageSelect, elements.targetLanguageCustomInput, settings.targetLanguage, targetLanguageOptions());
  elements.recognitionQualitySelect.value = settings.recognitionQuality;
  elements.unspokenPunctuationInput.checked = settings.unspokenPunctuation;
  elements.obsHostInput.value = settings.obsHost;
  elements.obsPortInput.value = settings.obsPort;
  elements.obsPasswordPersistInput.checked = settings.obsPasswordPersistLocal;
  elements.obsMicrophoneInputName.value = settings.obsMicrophoneInputName;
  elements.maxPendingInput.value = settings.maxPending;
  elements.maxAgeInput.value = settings.maxAgeMs;
  elements.maxCaptionCharsInput.value = settings.maxCaptionChars;
  elements.segmentIntervalInput.value = settings.segmentIntervalMs;
  elements.interimFlushCharsInput.value = settings.interimFlushChars;
  elements.replacementsInput.value = Object.keys(settings.replacements).length
    ? JSON.stringify(settings.replacements, null, 2)
    : "";
}

async function persistSettings() {
  const settings = readFormSettings();
  state.settings = await saveSettings(settings);
  await saveObsPassword(elements.obsPasswordInput.value, { persistLocal: state.settings.obsPasswordPersistLocal });
  logger.info(t("log_settingsSaved"));
  return state.settings;
}

function createChromeTranslator(settings) {
  state.translator?.destroy();
  state.translator = new ChromeTranslator({
    sourceLanguage: toTranslatorLanguageTag(settings.recognitionLanguage),
    targetLanguage: toTranslatorLanguageTag(settings.targetLanguage),
    onStatus: (status) => {
      if (status.state === "downloading") {
        setText("translationStatus", t("status_translationDownloading", [String(Math.round((status.progress ?? 0) * 100))]));
      } else if (status.state === "ready") {
        setText("translationStatus", t("status_translationReady"));
      } else if (status.state === "initializing") {
        setText("translationStatus", t("status_translationInitializing"));
      } else if (status.state === "error") {
        setText("translationStatus", t("status_error"));
      } else {
        setText("translationStatus", t("status_notReady"));
      }
    },
  });
  return state.translator;
}

function createRecognizer(settings) {
  state.interimCommitter = new InterimCommitter({ flushChars: settings.interimFlushChars });
  state.recognizer = new SpeechRecognizer({
    lang: settings.recognitionLanguage,
    quality: settings.recognitionQuality,
    unspokenPunctuation: settings.unspokenPunctuation,
    onInterim: (text) => {
      const cleaned = cleanTranscript(text, settings.replacements);
      elements.interimPreview.textContent = cleaned || "—";
      if (!state.running) return;
      // Flushes a long in-progress utterance to translation before Chrome
      // finalizes it, so translation doesn't wait for a whole run-on
      // sentence (see docs/HANDOFF.md 9.10). No-op while interimFlushChars
      // is 0 or the utterance hasn't crossed the threshold yet.
      for (const chunk of state.interimCommitter.update(cleaned)) {
        state.queue?.submit({ text: chunk, createdAt: Date.now() });
        logger.info(t("log_interimFlushed", [String(chunk.length)]));
      }
    },
    onFinal: (text) => {
      const cleaned = cleanTranscript(text, settings.replacements);
      elements.japanesePreview.textContent = cleaned || "—";
      if (!state.running) return;
      // Only the part beyond whatever interim flushing already committed —
      // see InterimCommitter.finalize().
      for (const chunk of state.interimCommitter.finalize(cleaned)) {
        state.queue?.submit({ text: chunk, createdAt: Date.now() });
      }
    },
    onState: (status) => {
      const labels = {
        recognizing: status.inputMode === "selected-track" ? t("status_recognizingSelected") : t("status_recognizing"),
        restarting: t("status_restarting"),
        stopped: t("status_stopped"),
        error: t("status_error"),
        "fallback-default-microphone": t("status_fallbackDefaultMic"),
        "fatal-error": FATAL_ERROR_LABELS[status.error] ?? t("status_fatalErrorDefault"),
      };
      setText("recognitionStatus", labels[status.state] ?? status.state);
      if (status.state === "recognizing") setText("microphoneStatus", t("status_micGranted"));
      // Chrome never finalizes an utterance across a restart/stop, so any
      // uncommitted interim tail is unrecoverable — drop it rather than let
      // it bleed into whatever starts next. Chunks already flushed stand.
      if (["stopped", "restarting", "error", "fatal-error"].includes(status.state)) {
        state.interimCommitter?.reset();
      }
      if (status.state === "fatal-error") {
        state.running = false;
        elements.startButton.disabled = false;
        elements.stopButton.disabled = true;
        setOverallStatus("error", labels["fatal-error"]);
      }
    },
    onError: (error) => logger.error(error.message),
  });
  return state.recognizer;
}

function createCaptionPipeline(settings) {
  state.policy = new CaptionPolicy({
    maxAgeMs: settings.maxAgeMs,
    maxCaptionChars: settings.maxCaptionChars,
    replacements: settings.replacements,
    allowCjkText: targetAllowsCjkText(settings.targetLanguage),
  });

  // Paces segment sends so a long utterance split into multiple captions
  // doesn't overwrite itself on Twitch before a viewer can read it
  // (see docs/HANDOFF.md 9.4). Persists across items on purpose: the
  // interval also applies between the last segment of one utterance and
  // the first segment of the next.
  state.pacer = new CaptionPacer({
    output: state.output,
    intervalMs: settings.segmentIntervalMs,
    shouldAbort: () => !state.running,
  });

  state.queue?.dispose();
  state.queue = new CaptionQueue({
    maxPending: settings.maxPending,
    maxAgeMs: settings.maxAgeMs,
    onDrop: (_item, reason, error) => {
      if (reason === "processor-error") logger.error(t("log_captionProcessFailed", [error?.message ?? "unknown error"]));
      else logger.warn(t("log_captionDropped", [reason]));
    },
    processor: async (item) => {
      if (!state.running) return;
      const translated = await state.translator.translate(item.text);
      elements.englishPreview.textContent = translated;
      const prepared = state.policy.prepare({ text: translated, createdAt: item.createdAt });
      if (!prepared.ok) {
        logger.warn(t("log_translatedCaptionDropped", [prepared.reason]));
        return;
      }

      let sentCount = 0;
      for (const segment of prepared.segments) {
        if (!state.running) return;
        const result = await state.pacer.sendCaption(segment);
        if (!result.sent) {
          // "aborted" means the user stopped CC (or a fatal error stopped
          // it) while this segment was waiting out the pacing interval —
          // expected, not worth a warning.
          if (result.reason !== "aborted") logger.warn(t("log_captionSendFailed", [result.reason]));
          return;
        }
        sentCount += 1;
      }
      if (sentCount === prepared.segments.length) {
        state.policy.markSent(prepared.canonicalText);
        logger.info(t("log_captionsSent", [String(sentCount)]));
      }
    },
  });
}

async function connectObs() {
  const settings = await persistSettings();
  const password = elements.obsPasswordInput.value;
  state.obsClient?.disconnect();
  clearInterval(state.statusTimer);
  state.statusTimer = null;

  const url = buildObsWebSocketUrl({ host: settings.obsHost, port: settings.obsPort });
  state.obsClient = new ObsWebSocketClient({
    url,
    password,
    onState: (status) => {
      const labels = {
        connecting: t("status_obsConnecting"),
        connected: t("status_obsConnected"),
        disconnected: t("status_disconnected"),
        error: t("status_error"),
      };
      setText("obsStatus", labels[status.state] ?? status.state);
      if (status.state === "error") logger.error(status.error?.message ?? t("err_obsConnectError"));
    },
  });

  await state.obsClient.connect();
  state.output = new ObsCaptionOutput({
    client: state.obsClient,
    microphoneInputName: settings.obsMicrophoneInputName,
  });
  // If captions are already running, rebind the pacer created in
  // createCaptionPipeline() to the fresh output right away — even if
  // initialize() below throws, the old output's client is already
  // disconnected (see the disconnect() call above), so the pacer should
  // not keep pointing at it either (see docs/HANDOFF.md 9.7 and
  // src/captions/caption-pacer.js).
  state.pacer?.setOutput(state.output);
  await state.output.initialize();
  elements.testCaptionButton.disabled = false;
  logger.info(t("log_obsConnected", [url]));
  await refreshObsStatus();
  state.statusTimer = setInterval(() => { void refreshObsStatus(); }, 2500);
}

async function refreshObsStatus() {
  if (!state.output) return;
  try {
    const status = await state.output.status();
    setText("streamStatus", status.streaming ? "LIVE" : "OFFLINE");
    if (status.microphoneMuted === true) setText("microphoneStatus", t("status_micMutedInObs"));
    else if (state.running) setText("microphoneStatus", t("status_micOn"));
  } catch (error) {
    setText("streamStatus", t("status_streamFetchFailed"));
    logger.warn(t("log_obsStatusFetchFailed", [error.message]));
  }
}

// Thin DOM glue around BroadcastChannel, matching the injection contract
// awaitHelperCompletion() expects (see src/permission/mic-permission-flow.js).
function subscribeMicPermissionResult(handler) {
  const channel = new BroadcastChannel(MIC_PERMISSION_CHANNEL);
  channel.onmessage = (event) => handler(event.data);
  return () => channel.close();
}

// Works around a Chrome limitation: the Side Panel cannot reliably render
// the native getUserMedia permission prompt, so when the extension's
// microphone permission is still unset ("prompt"), calling getUserMedia
// directly here fails immediately with NotAllowedError and no dialog ever
// appears. See docs/HANDOFF.md 9.9 for the full writeup.
async function ensureMicrophonePermission(recognizer) {
  if (state.micPermissionWaiting) {
    state.micHelperWindow?.focus();
    logger.info(t("log_micPermissionInProgress"));
    return false;
  }
  // Set before any await, not just once a helper tab actually opens: the
  // guard above must also catch a second click landing during the
  // permissions.query()/direct-getUserMedia awaits below, before any tab
  // exists yet — otherwise a fast double-click could open two helper tabs.
  state.micPermissionWaiting = true;
  try {
    const permissionState = await queryMicrophonePermission(navigator.permissions);
    const action = decideMicPermissionAction(permissionState);

    if (action === "explain-denied") {
      setText("microphoneStatus", t("status_micBlocked"));
      logger.error(t("err_micBlocked"));
      return false;
    }

    if (action === "request-direct") {
      try {
        await recognizer.requestPermission(elements.microphoneSelect.value || "");
        setText("microphoneStatus", t("status_micGranted"));
        return true;
      } catch (error) {
        if (!shouldOpenHelperAfterFailure({ permissionState, errorName: error?.name })) throw error;
        // Falls through to the helper-tab flow below.
      }
    }

    const helperUrl = chrome.runtime.getURL("src/permission/mic-permission.html");
    state.micHelperWindow = window.open(helperUrl);
    if (!state.micHelperWindow) {
      logger.error(t("err_micHelperOpenFailed"));
      return false;
    }

    setText("microphoneStatus", t("status_micWaitingHelper"));
    logger.info(t("log_micHelperOpened"));

    const result = await awaitHelperCompletion({
      isClosed: () => state.micHelperWindow?.closed === true,
      subscribe: subscribeMicPermissionResult,
    });

    if (result.outcome === "closed") {
      // Race fallback: the helper posts its result and only then
      // self-closes, so a message normally wins, but re-check once in case
      // the tab was closed exactly as the grant landed.
      if ((await queryMicrophonePermission(navigator.permissions)) === "granted") {
        setText("microphoneStatus", t("status_micGranted"));
        return true;
      }
      setText("microphoneStatus", t("status_unauthorized"));
      logger.warn(t("log_micHelperClosed"));
      return false;
    }

    if (result.outcome === "denied") {
      // A dismissed prompt (user closed the dialog without choosing) also
      // rejects with NotAllowedError but leaves the origin permission in
      // "prompt", not "denied" — re-check so that case isn't mislabeled as
      // a hard block with settings instructions that don't actually apply.
      if ((await queryMicrophonePermission(navigator.permissions)) === "denied") {
        setText("microphoneStatus", t("status_micBlocked"));
        logger.error(t("err_micBlocked"));
      } else {
        setText("microphoneStatus", t("status_unauthorized"));
        logger.warn(t("log_micPermissionIncomplete"));
      }
      return false;
    }

    // result.outcome === "granted": the origin permission is granted now,
    // so this retry in the side panel succeeds silently (no second prompt).
    await recognizer.requestPermission(elements.microphoneSelect.value || "");
    setText("microphoneStatus", t("status_micGranted"));
    logger.info(t("log_micGranted"));
    return true;
  } finally {
    state.micPermissionWaiting = false;
    state.micHelperWindow = null;
  }
}

async function refreshMicrophones({ requestPermission = false } = {}) {
  const recognizer = state.recognizer ?? createRecognizer(state.settings);
  if (requestPermission) {
    await ensureMicrophonePermission(recognizer);
  } else {
    await refreshMicrophoneStatus();
  }
  const devices = await recognizer.listMicrophones();
  const selected = state.settings?.microphoneDeviceId || elements.microphoneSelect.value;
  elements.microphoneSelect.replaceChildren(...devices.map((device) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label;
    return option;
  }));
  if (!devices.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = t("ui_defaultMicOption");
    elements.microphoneSelect.append(option);
  }
  if ([...elements.microphoneSelect.options].some((option) => option.value === selected)) {
    elements.microphoneSelect.value = selected;
  }
}

// Reflects the real microphone permission into the status row. The side
// panel's opening HTML label hardcodes "unauthorized", so without this the
// panel would keep showing 未許可 even when the extension origin is already
// allowed (the initial grant happens in the helper tab, docs/HANDOFF.md 9.9).
async function refreshMicrophoneStatus() {
  const permissionState = await queryMicrophonePermission(navigator.permissions);
  const key = microphoneStatusKey(permissionState);
  if (key) setText("microphoneStatus", t(key));
}

async function startCaptions() {
  try {
    const settings = await persistSettings();
    if (!state.obsClient?.connected) await connectObs();
    if (state.output) state.output.microphoneInputName = settings.obsMicrophoneInputName;
    createChromeTranslator(settings);
    createRecognizer(settings);
    createCaptionPipeline(settings);

    const sourceLanguage = toTranslatorLanguageTag(settings.recognitionLanguage);
    const targetLanguage = toTranslatorLanguageTag(settings.targetLanguage);
    const availability = await state.translator.availability();
    if (availability === "unavailable") {
      throw new Error(t("err_translatorPairUnavailable", [sourceLanguage, targetLanguage]));
    }
    await state.translator.initialize();

    state.running = true;
    await state.recognizer.start({ deviceId: settings.microphoneDeviceId });
    elements.startButton.disabled = true;
    elements.stopButton.disabled = false;
    setOverallStatus("running", t("status_sending"));
    logger.info(t("log_ccStarted", [settings.recognitionLanguage, targetLanguage]));
  } catch (error) {
    state.running = false;
    setOverallStatus("error", t("status_startFailed"));
    logger.error(error.message);
    await state.recognizer?.stop();
  }
}

async function stopCaptions() {
  state.running = false;
  state.queue?.clear("stopped");
  await state.recognizer?.stop();
  elements.startButton.disabled = false;
  elements.stopButton.disabled = true;
  setOverallStatus("idle", t("status_stopped"));
  logger.info(t("log_ccStopped"));
}

async function sendTestCaption() {
  try {
    if (!state.output) throw new Error(t("err_obsNotConnected"));
    const result = await state.output.sendCaption("Closed captions are ready.", { bypassMicrophoneGate: true });
    if (!result.sent) throw new Error(t("err_testCaptionFailed", [result.reason]));
    logger.info(t("log_testCaptionSent"));
  } catch (error) {
    logger.error(error.message);
  }
}

async function initialize() {
  document.documentElement.lang = globalThis.chrome?.i18n?.getUILanguage?.() ?? document.documentElement.lang;
  applyTranslations(document, t);
  populateLanguageSelect(elements.recognitionLanguageSelect, recognitionLanguageOptions());
  populateLanguageSelect(elements.targetLanguageSelect, targetLanguageOptions());

  state.settings = await loadSettings();
  populateSettings(state.settings);
  void updatePairAvailability();
  elements.obsPasswordInput.value = await loadObsPassword();
  const translator = createChromeTranslator(state.settings);
  const recognizer = createRecognizer(state.settings);
  const probe = recognizer.probe();
  setText("chromeStatus", translator.supported && probe.speechRecognition ? t("status_chromeSupported") : t("status_chromePartial"));
  const availability = await translator.availability().catch(() => "unknown");
  setText("translationStatus", availability === "available" ? t("status_translationReady") : availability === "unavailable" ? t("status_translationUnavailable") : t("status_translationNeedsSetup"));
  await refreshMicrophones();
  logger.info(t("log_extensionLoaded"));
}

elements.refreshMicrophonesButton.addEventListener("click", () => {
  void refreshMicrophones({ requestPermission: true }).catch((error) => logger.error(error.message));
});
elements.recognitionLanguageSelect.addEventListener("change", () => {
  toggleCustomInputVisibility(elements.recognitionLanguageSelect, elements.recognitionLanguageCustomInput);
  void updatePairAvailability();
});
elements.targetLanguageSelect.addEventListener("change", () => {
  toggleCustomInputVisibility(elements.targetLanguageSelect, elements.targetLanguageCustomInput);
  void updatePairAvailability();
});
elements.recognitionLanguageCustomInput.addEventListener("input", debouncedUpdatePairAvailability);
elements.targetLanguageCustomInput.addEventListener("input", debouncedUpdatePairAvailability);
elements.swapLanguagesButton.addEventListener("click", () => {
  const swapped = swapLanguagePair({
    recognitionLanguage: readRecognitionLanguage(),
    targetLanguage: readTargetLanguage(),
  });
  setLanguageControl(elements.recognitionLanguageSelect, elements.recognitionLanguageCustomInput, swapped.recognitionLanguage, recognitionLanguageOptions());
  setLanguageControl(elements.targetLanguageSelect, elements.targetLanguageCustomInput, swapped.targetLanguage, targetLanguageOptions());
  void updatePairAvailability();
});
elements.connectObsButton.addEventListener("click", () => {
  void connectObs().catch((error) => logger.error(error.message));
});
elements.testCaptionButton.addEventListener("click", () => { void sendTestCaption(); });
elements.saveSettingsButton.addEventListener("click", () => {
  void persistSettings().catch((error) => logger.error(error.message));
});
elements.obsPasswordPersistInput.addEventListener("change", () => {
  // Persists immediately in both directions, rather than waiting for
  // "Save settings": checking the box is itself the user's explicit consent
  // to start storing the password on disk, and unchecking it must delete
  // the on-disk copy right away so the settings flag and the actual
  // chrome.storage.local mirror never drift apart (see docs/HANDOFF.md 6,
  // item 2).
  const persisting = elements.obsPasswordPersistInput.checked;
  void persistSettings()
    .then(() => {
      logger.info(persisting ? t("log_obsPasswordSaved") : t("log_obsPasswordRemoved"));
    })
    .catch((error) => logger.error(error.message));
});
elements.startButton.addEventListener("click", () => { void startCaptions(); });
elements.stopButton.addEventListener("click", () => { void stopCaptions(); });
elements.clearLogButton.addEventListener("click", () => {
  logger.entries.length = 0;
  renderLog([]);
});

window.addEventListener("beforeunload", () => {
  state.running = false;
  state.queue?.dispose();
  void state.recognizer?.stop();
  state.translator?.destroy();
  state.obsClient?.disconnect();
  clearInterval(state.statusTimer);
});

void initialize().catch((error) => {
  setOverallStatus("error", t("status_initFailed"));
  logger.error(error.message);
});
