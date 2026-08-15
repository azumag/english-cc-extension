import { CaptionPacer } from "../captions/caption-pacer.js";
import { CaptionPolicy } from "../captions/caption-policy.js";
import { CaptionQueue } from "../captions/caption-queue.js";
import { ObsCaptionOutput } from "../obs/obs-caption-output.js";
import { ObsWebSocketClient, buildObsWebSocketUrl } from "../obs/obs-websocket-client.js";
import {
  MIC_PERMISSION_CHANNEL,
  awaitHelperCompletion,
  decideMicPermissionAction,
  queryMicrophonePermission,
  shouldOpenHelperAfterFailure,
} from "../permission/mic-permission-flow.js";
import { SpeechRecognizer } from "../speech/speech-recognizer.js";
import { ChromeTranslator } from "../translation/chrome-translator.js";
import { targetAllowsCjkText, toTranslatorLanguageTag } from "../translation/language-tags.js";
import { RingLogger } from "../shared/logger.js";
import { normalizeSettings } from "../shared/contracts.js";
import { loadObsPassword, loadSettings, saveObsPassword, saveSettings } from "../settings/settings-store.js";

// Matches the fatal errors SpeechRecognizer stops retrying on
// (see src/speech/speech-recognizer.js FATAL_ERRORS) with a Japanese
// message telling the user what manual step unblocks a restart.
const FATAL_ERROR_LABELS = {
  "not-allowed": "マイク権限を許可してから再開してください",
  "service-not-allowed": "音声認識サービスが許可されていません。設定を確認してから再開してください",
  "language-not-supported": "選択した認識言語は音声認識でサポートされていません",
};

const elements = Object.fromEntries([
  "overallStatus", "chromeStatus", "microphoneStatus", "recognitionStatus", "translationStatus", "obsStatus", "streamStatus",
  "microphoneSelect", "refreshMicrophonesButton", "recognitionLanguageInput", "targetLanguageInput",
  "obsHostInput", "obsPortInput", "obsPasswordInput", "obsPasswordPersistInput", "obsMicrophoneInputName",
  "connectObsButton", "testCaptionButton", "maxPendingInput", "maxAgeInput", "maxCaptionCharsInput", "segmentIntervalInput", "replacementsInput",
  "saveSettingsButton", "interimPreview", "japanesePreview", "englishPreview", "startButton", "stopButton", "clearLogButton", "eventLog",
].map((id) => [id, document.getElementById(id)]));

const state = {
  settings: null,
  translator: null,
  recognizer: null,
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
    throw new TypeError("固有名詞置換はJSONオブジェクトで指定してください");
  }
  return value;
}

function readFormSettings() {
  return normalizeSettings({
    recognitionLanguage: elements.recognitionLanguageInput.value.trim(),
    targetLanguage: elements.targetLanguageInput.value.trim(),
    microphoneDeviceId: elements.microphoneSelect.value,
    obsHost: elements.obsHostInput.value,
    obsPort: Number(elements.obsPortInput.value),
    obsPasswordPersistLocal: elements.obsPasswordPersistInput.checked,
    obsMicrophoneInputName: elements.obsMicrophoneInputName.value,
    maxPending: Number(elements.maxPendingInput.value),
    maxAgeMs: Number(elements.maxAgeInput.value),
    maxCaptionChars: Number(elements.maxCaptionCharsInput.value),
    segmentIntervalMs: Number(elements.segmentIntervalInput.value),
    replacements: parseReplacements(),
    logCaptions: false,
  });
}

function populateSettings(settings) {
  elements.recognitionLanguageInput.value = settings.recognitionLanguage;
  elements.targetLanguageInput.value = settings.targetLanguage;
  elements.obsHostInput.value = settings.obsHost;
  elements.obsPortInput.value = settings.obsPort;
  elements.obsPasswordPersistInput.checked = settings.obsPasswordPersistLocal;
  elements.obsMicrophoneInputName.value = settings.obsMicrophoneInputName;
  elements.maxPendingInput.value = settings.maxPending;
  elements.maxAgeInput.value = settings.maxAgeMs;
  elements.maxCaptionCharsInput.value = settings.maxCaptionChars;
  elements.segmentIntervalInput.value = settings.segmentIntervalMs;
  elements.replacementsInput.value = Object.keys(settings.replacements).length
    ? JSON.stringify(settings.replacements, null, 2)
    : "";
}

async function persistSettings() {
  const settings = readFormSettings();
  state.settings = await saveSettings(settings);
  await saveObsPassword(elements.obsPasswordInput.value, { persistLocal: state.settings.obsPasswordPersistLocal });
  logger.info("設定を保存しました");
  return state.settings;
}

function createTranslator(settings) {
  state.translator?.destroy();
  state.translator = new ChromeTranslator({
    sourceLanguage: toTranslatorLanguageTag(settings.recognitionLanguage),
    targetLanguage: toTranslatorLanguageTag(settings.targetLanguage),
    onStatus: (status) => {
      if (status.state === "downloading") {
        setText("translationStatus", `ダウンロード ${Math.round((status.progress ?? 0) * 100)}%`);
      } else if (status.state === "ready") {
        setText("translationStatus", "利用可能");
      } else if (status.state === "initializing") {
        setText("translationStatus", "準備中");
      } else if (status.state === "error") {
        setText("translationStatus", "エラー");
      } else {
        setText("translationStatus", "未準備");
      }
    },
  });
  return state.translator;
}

function createRecognizer(settings) {
  state.recognizer = new SpeechRecognizer({
    lang: settings.recognitionLanguage,
    onInterim: (text) => {
      elements.interimPreview.textContent = text || "—";
    },
    onFinal: (text) => {
      elements.japanesePreview.textContent = text;
      if (state.running) state.queue?.submit({ text, createdAt: Date.now() });
    },
    onState: (status) => {
      const labels = {
        recognizing: status.inputMode === "selected-track" ? "聞き取り中（選択マイク）" : "聞き取り中",
        restarting: "再開待ち",
        stopped: "停止",
        error: "エラー",
        "fallback-default-microphone": "既定マイクへ切替",
        "fatal-error": FATAL_ERROR_LABELS[status.error] ?? "停止（要再操作）",
      };
      setText("recognitionStatus", labels[status.state] ?? status.state);
      if (status.state === "recognizing") setText("microphoneStatus", "許可済み");
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
      if (reason === "processor-error") logger.error(`字幕処理に失敗: ${error?.message ?? "unknown error"}`);
      else logger.warn(`字幕を破棄しました: ${reason}`);
    },
    processor: async (item) => {
      if (!state.running) return;
      const translated = await state.translator.translate(item.text);
      elements.englishPreview.textContent = translated;
      const prepared = state.policy.prepare({ text: translated, createdAt: item.createdAt });
      if (!prepared.ok) {
        logger.warn(`翻訳字幕を送らず破棄しました: ${prepared.reason}`);
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
          if (result.reason !== "aborted") logger.warn(`字幕を送信できませんでした: ${result.reason}`);
          return;
        }
        sentCount += 1;
      }
      if (sentCount === prepared.segments.length) {
        state.policy.markSent(prepared.canonicalText);
        logger.info(`翻訳字幕を送信しました（${sentCount}件）`);
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
        connecting: "接続中",
        connected: "接続済み",
        disconnected: "未接続",
        error: "エラー",
      };
      setText("obsStatus", labels[status.state] ?? status.state);
      if (status.state === "error") logger.error(status.error?.message ?? "OBS接続エラー");
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
  logger.info(`OBSへ接続しました: ${url}`);
  await refreshObsStatus();
  state.statusTimer = setInterval(() => { void refreshObsStatus(); }, 2500);
}

async function refreshObsStatus() {
  if (!state.output) return;
  try {
    const status = await state.output.status();
    setText("streamStatus", status.streaming ? "LIVE" : "OFFLINE");
    if (status.microphoneMuted === true) setText("microphoneStatus", "OBSでミュート");
    else if (state.running) setText("microphoneStatus", "ON");
  } catch (error) {
    setText("streamStatus", "取得失敗");
    logger.warn(`OBS状態を取得できません: ${error.message}`);
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
    logger.info("マイクの許可処理を実行中です。しばらくお待ちください");
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
      setText("microphoneStatus", "ブロック中");
      logger.error("マイクがブロックされています。chrome://settings/content/microphone でこの拡張機能を「許可」に変更してから、もう一度「更新・許可」を押してください");
      return false;
    }

    if (action === "request-direct") {
      try {
        await recognizer.requestPermission(elements.microphoneSelect.value || "");
        setText("microphoneStatus", "許可済み");
        return true;
      } catch (error) {
        if (!shouldOpenHelperAfterFailure({ permissionState, errorName: error?.name })) throw error;
        // Falls through to the helper-tab flow below.
      }
    }

    const helperUrl = chrome.runtime.getURL("src/permission/mic-permission.html");
    state.micHelperWindow = window.open(helperUrl);
    if (!state.micHelperWindow) {
      logger.error("マイク許可用のタブを開けませんでした。もう一度「更新・許可」を押してください");
      return false;
    }

    setText("microphoneStatus", "許可待ち（別タブ）");
    logger.info("マイク許可用のタブを開きました。表示されるダイアログで「許可」を選んでください");

    const result = await awaitHelperCompletion({
      isClosed: () => state.micHelperWindow?.closed === true,
      subscribe: subscribeMicPermissionResult,
    });

    if (result.outcome === "closed") {
      // Race fallback: the helper posts its result and only then
      // self-closes, so a message normally wins, but re-check once in case
      // the tab was closed exactly as the grant landed.
      if ((await queryMicrophonePermission(navigator.permissions)) === "granted") {
        setText("microphoneStatus", "許可済み");
        return true;
      }
      setText("microphoneStatus", "未許可");
      logger.warn("マイク許可用のタブが閉じられました。許可されていません");
      return false;
    }

    if (result.outcome === "denied") {
      // A dismissed prompt (user closed the dialog without choosing) also
      // rejects with NotAllowedError but leaves the origin permission in
      // "prompt", not "denied" — re-check so that case isn't mislabeled as
      // a hard block with settings instructions that don't actually apply.
      if ((await queryMicrophonePermission(navigator.permissions)) === "denied") {
        setText("microphoneStatus", "ブロック中");
        logger.error("マイクがブロックされています。chrome://settings/content/microphone でこの拡張機能を「許可」に変更してから、もう一度「更新・許可」を押してください");
      } else {
        setText("microphoneStatus", "未許可");
        logger.warn("マイクの許可が完了しませんでした。もう一度「更新・許可」を押すか、許可用タブの「もう一度許可を要求」を押してください");
      }
      return false;
    }

    // result.outcome === "granted": the origin permission is granted now,
    // so this retry in the side panel succeeds silently (no second prompt).
    await recognizer.requestPermission(elements.microphoneSelect.value || "");
    setText("microphoneStatus", "許可済み");
    logger.info("マイクを許可しました");
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
    option.textContent = "既定のマイク";
    elements.microphoneSelect.append(option);
  }
  if ([...elements.microphoneSelect.options].some((option) => option.value === selected)) {
    elements.microphoneSelect.value = selected;
  }
}

async function startCaptions() {
  try {
    const settings = await persistSettings();
    if (!state.obsClient?.connected) await connectObs();
    if (state.output) state.output.microphoneInputName = settings.obsMicrophoneInputName;
    createTranslator(settings);
    createRecognizer(settings);
    createCaptionPipeline(settings);

    const sourceLanguage = toTranslatorLanguageTag(settings.recognitionLanguage);
    const targetLanguage = toTranslatorLanguageTag(settings.targetLanguage);
    const availability = await state.translator.availability();
    if (availability === "unavailable") {
      throw new Error(`${sourceLanguage}→${targetLanguage} のChrome Translator APIを利用できません`);
    }
    await state.translator.initialize();

    state.running = true;
    await state.recognizer.start({ deviceId: settings.microphoneDeviceId });
    elements.startButton.disabled = true;
    elements.stopButton.disabled = false;
    setOverallStatus("running", "送出中");
    logger.info(`CCを開始しました（${settings.recognitionLanguage} → ${targetLanguage}）`);
  } catch (error) {
    state.running = false;
    setOverallStatus("error", "開始失敗");
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
  setOverallStatus("idle", "停止中");
  logger.info("CCを停止しました");
}

async function sendTestCaption() {
  try {
    if (!state.output) throw new Error("先にOBSへ接続してください");
    const result = await state.output.sendCaption("Closed captions are ready.", { bypassMicrophoneGate: true });
    if (!result.sent) throw new Error(`テスト字幕を送信できません: ${result.reason}`);
    logger.info("テスト字幕を送信しました");
  } catch (error) {
    logger.error(error.message);
  }
}

async function initialize() {
  state.settings = await loadSettings();
  populateSettings(state.settings);
  elements.obsPasswordInput.value = await loadObsPassword();
  const translator = createTranslator(state.settings);
  const recognizer = createRecognizer(state.settings);
  const probe = recognizer.probe();
  setText("chromeStatus", translator.supported && probe.speechRecognition ? "対応" : "一部非対応");
  const availability = await translator.availability().catch(() => "unknown");
  setText("translationStatus", availability === "available" ? "利用可能" : availability === "unavailable" ? "利用不可" : "初回準備が必要");
  await refreshMicrophones();
  logger.info("拡張を読み込みました");
}

elements.refreshMicrophonesButton.addEventListener("click", () => {
  void refreshMicrophones({ requestPermission: true }).catch((error) => logger.error(error.message));
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
  // "設定を保存": checking the box is itself the user's explicit consent to
  // start storing the password on disk ("チェックマークを入れると保存され
  // る"), and unchecking it must delete the on-disk copy right away so the
  // settings flag and the actual chrome.storage.local mirror never drift
  // apart (see docs/HANDOFF.md 6, item 2).
  const persisting = elements.obsPasswordPersistInput.checked;
  void persistSettings()
    .then(() => {
      logger.info(persisting
        ? "OBSパスワードをこのデバイスに保存しました"
        : "保存済みのOBSパスワードをこのデバイスから削除しました");
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
  setOverallStatus("error", "初期化失敗");
  logger.error(error.message);
});
