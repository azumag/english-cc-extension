function recognitionConstructor(globalScope) {
  return globalScope.SpeechRecognition ?? globalScope.webkitSpeechRecognition ?? null;
}

// Errors the Web Speech API defines as unrecoverable without user action
// (permission grant, browser settings, or picking a supported language).
// Retrying start() after these fires the same rejection forever, so we
// stop instead of scheduling another restart.
// https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognitionError/error
const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "language-not-supported"]);

// Chrome ends recognition sessions all the time (silence, service resets,
// page hidden), so the restart path has to be fast and self-healing. The
// onend-driven backoff still doubles up to 5s to avoid hot-looping when the
// session dies immediately after starting, but a start() call that throws
// (e.g. InvalidStateError from a session still winding down, or a dead mic
// track) retries on a much tighter schedule.
const RESTART_ONEND_MIN_MS = 250;
const RESTART_ONEND_MAX_MS = 5000;
const START_RETRY_BASE_MS = 500;
const START_RETRY_MAX_MS = 2000;
const WATCHDOG_INTERVAL_MS = 5000;

export class SpeechRecognizer {
  constructor({
    lang = "ja-JP",
    quality = "conversation",
    unspokenPunctuation = true,
    globalScope = globalThis,
    mediaDevices = globalThis.navigator?.mediaDevices,
    onInterim = () => {},
    onFinal = () => {},
    onState = () => {},
    onError = () => {},
    // Chrome sometimes stops a session without firing onerror/onend at all.
    // The watchdog restarts recognition when no result has arrived for this
    // long, so a silently-stuck session self-heals instead of dying mid-sentence.
    silenceLimitMs = 90_000,
    watchdogIntervalMs = WATCHDOG_INTERVAL_MS,
    clock = Date.now,
  } = {}) {
    this.lang = lang;
    this.quality = quality;
    this.unspokenPunctuation = unspokenPunctuation;
    this.globalScope = globalScope;
    this.mediaDevices = mediaDevices;
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onState = onState;
    this.onError = onError;
    this.silenceLimitMs = silenceLimitMs;
    this.watchdogIntervalMs = watchdogIntervalMs;
    this.clock = clock;
    this.recognition = null;
    this.stream = null;
    this.deviceId = "";
    this.desired = false;
    this.active = false;
    this.restartTimer = null;
    this.restartDelayMs = RESTART_ONEND_MIN_MS;
    this.startFailures = 0;
    this.watchdogTimer = null;
    this.lastActivityAt = 0;
    this.inputMode = "unknown";
    this.fatalError = null;
  }

  probe() {
    const prototype = recognitionConstructor(this.globalScope)?.prototype ?? null;
    return {
      speechRecognition: Boolean(recognitionConstructor(this.globalScope)),
      mediaDevices: Boolean(this.mediaDevices?.getUserMedia && this.mediaDevices?.enumerateDevices),
      localRecognitionProperty: Boolean(prototype && "processLocally" in prototype),
      quality: Boolean(prototype && "quality" in prototype),
      unspokenPunctuation: Boolean(prototype && "unspokenPunctuation" in prototype),
    };
  }

  async requestPermission(deviceId = "") {
    if (!this.mediaDevices?.getUserMedia) throw new Error("MediaDevices API is unavailable");
    const stream = await this.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
    stream.getTracks().forEach((track) => track.stop());
  }

  async listMicrophones() {
    if (!this.mediaDevices?.enumerateDevices) return [];
    const devices = await this.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Microphone ${index + 1}`,
      }));
  }

  async start({ deviceId = "" } = {}) {
    if (this.desired) return;
    const Recognition = recognitionConstructor(this.globalScope);
    if (!Recognition) throw new Error("SpeechRecognition is unavailable in this Chrome build");
    if (!this.mediaDevices?.getUserMedia) throw new Error("Microphone access is unavailable");

    this.desired = true;
    this.deviceId = deviceId;
    this.restartDelayMs = RESTART_ONEND_MIN_MS;
    this.startFailures = 0;
    this.fatalError = null;
    try {
      this.stream = await this.#acquireStream(deviceId);
    } catch (error) {
      this.desired = false;
      this.onState({ state: "error", error: "microphone-permission" });
      throw error;
    }

    this.#createRecognition();
    this.#startWatchdog();
    try {
      this.#startRecognition();
    } catch (error) {
      this.desired = false;
      this.#stopWatchdog();
      this.stream?.getTracks().forEach((track) => track.stop());
      this.stream = null;
      this.recognition = null;
      throw error;
    }
  }

  async stop() {
    this.desired = false;
    this.fatalError = null;
    this.#stopWatchdog();
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.recognition) {
      try { this.recognition.stop(); } catch {}
      try { this.recognition.abort(); } catch {}
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recognition = null;
    this.active = false;
    this.onInterim("");
    this.onState({ state: "stopped" });
  }

  // getUserMedia with a mono, gain-normalized audio input. Falls back to the
  // default device if the exact one vanished (unplugged / switched off).
  async #acquireStream(deviceId = this.deviceId) {
    const audio = {
      echoCancellation: true,
      noiseSuppression: true,
      // Gain normalization and a single channel give the recognition
      // service a clean, stable input; disabling AGC leaves quiet or
      // level-shifting mics hard to hear.
      autoGainControl: true,
      channelCount: 1,
    };
    if (!deviceId) return this.mediaDevices.getUserMedia({ audio });
    try {
      return await this.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: deviceId } } });
    } catch (error) {
      if (error?.name !== "OverconstrainedError") throw error;
      return this.mediaDevices.getUserMedia({ audio });
    }
  }

  // The mic track can end on its own (device unplugged, OS device switch).
  // Restarting with an ended track throws forever, so re-acquire first.
  async #ensureUsableStream() {
    const track = this.stream?.getAudioTracks?.()[0] ?? null;
    if (track && track.readyState !== "ended") return;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = await this.#acquireStream();
  }

  // A fresh instance per session: Chrome's implementation can get stuck in
  // an internal error state when the same object is reused across many
  // error/end cycles, so each restart starts from a clean object.
  #createRecognition() {
    const Recognition = recognitionConstructor(this.globalScope);
    if (!Recognition) throw new Error("SpeechRecognition is unavailable in this Chrome build");
    const recognition = new Recognition();
    this.recognition = recognition;
    recognition.lang = this.lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    // Chrome 138+ exposes a recognition quality mode (command/dictation/
    // conversation) and automatic unspoken-punctuation insertion. Both are
    // feature-flagged in some versions, so probe the instance and skip what
    // the running Chrome doesn't expose (see docs/HANDOFF.md 9.12).
    if (this.quality && "quality" in recognition) {
      recognition.quality = this.quality;
    }
    if (this.unspokenPunctuation && "unspokenPunctuation" in recognition) {
      recognition.unspokenPunctuation = true;
    }

    recognition.onstart = () => {
      this.active = true;
      this.restartDelayMs = RESTART_ONEND_MIN_MS;
      this.startFailures = 0;
      this.#touchActivity();
      this.onState({ state: "recognizing", inputMode: this.inputMode });
    };

    recognition.onresult = (event) => {
      this.#touchActivity();
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = String(result[0]?.transcript ?? "").trim();
        if (!transcript) continue;
        if (result.isFinal) this.onFinal(transcript);
        else interim = `${interim} ${transcript}`.trim();
      }
      this.onInterim(interim);
    };

    recognition.onerror = (event) => {
      const error = String(event.error ?? "unknown");
      if (!this.desired && error === "aborted") return;
      if (FATAL_ERRORS.has(error)) {
        this.fatalError = error;
        this.desired = false;
        this.#stopWatchdog();
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      if (error === "aborted") {
        // Chrome aborts the session when the page is hidden or the service
        // resets. That's a normal restart trigger, not a user-facing error.
        this.onState({ state: "restarting", error });
        return;
      }
      this.onError(new Error(`Speech recognition error: ${error}`));
      this.onState({ state: this.fatalError ? "fatal-error" : "error", error });
    };

    recognition.onend = () => {
      this.active = false;
      // The session is over; discard the instance so the next restart builds
      // a fresh one (see #createRecognition).
      this.recognition = null;
      if (this.fatalError) {
        // onerror already released the mic/timer and flipped desired off;
        // report the fatal state again instead of falling through to the
        // generic "stopped" status so the UI keeps its permission prompt.
        this.onState({ state: "fatal-error", error: this.fatalError });
        return;
      }
      if (!this.desired) {
        this.onState({ state: "stopped" });
        return;
      }
      this.onState({ state: "restarting" });
      this.#scheduleRestart();
    };
  }

  #startRecognition() {
    if (!this.desired || !this.recognition) return;
    const track = this.stream?.getAudioTracks?.()[0] ?? null;
    try {
      if (track) {
        this.recognition.start(track);
        this.inputMode = "selected-track";
      } else {
        this.recognition.start();
        this.inputMode = "browser-default";
      }
    } catch (error) {
      if (!track || error?.name === "InvalidStateError") throw error;
      this.inputMode = "browser-default";
      this.onState({ state: "fallback-default-microphone" });
      this.recognition.start();
    }
  }

  #scheduleRestart() {
    clearTimeout(this.restartTimer);
    const delay = this.restartDelayMs;
    this.restartDelayMs = Math.min(RESTART_ONEND_MAX_MS, this.restartDelayMs * 2);
    this.#touchActivity();
    this.restartTimer = setTimeout(() => { void this.#restartNow(); }, delay);
  }

  // A start() that throws (InvalidStateError right after onend, dead track,
  // service not ready) retries on a short bounded schedule instead of the
  // 5s-capped onend backoff, so a brief glitch costs at most a second or two.
  #scheduleStartRetry() {
    clearTimeout(this.restartTimer);
    this.startFailures += 1;
    const delay = Math.min(START_RETRY_MAX_MS, START_RETRY_BASE_MS * 2 ** (this.startFailures - 1));
    this.#touchActivity();
    this.restartTimer = setTimeout(() => { void this.#restartNow(); }, delay);
  }

  async #restartNow() {
    if (!this.desired) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    try {
      await this.#ensureUsableStream();
      if (!this.desired) {
        // stop() landed while the stream was being re-acquired; don't start
        // a fresh session the user just asked to end.
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = null;
        return;
      }
      this.#createRecognition();
      this.#startRecognition();
    } catch (error) {
      this.onError(error);
      this.#scheduleStartRetry();
    }
  }

  #startWatchdog() {
    this.#stopWatchdog();
    this.lastActivityAt = this.clock();
    this.watchdogTimer = setInterval(() => {
      if (!this.desired || this.fatalError) return;
      if (this.clock() - this.lastActivityAt <= this.silenceLimitMs) return;
      // No result for a long time and no onerror/onend to restart from:
      // the session is likely stuck, so force a clean restart.
      this.active = false;
      this.recognition = null;
      this.onState({ state: "restarting", error: "watchdog-timeout" });
      void this.#restartNow();
    }, this.watchdogIntervalMs);
  }

  #stopWatchdog() {
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  #touchActivity() {
    this.lastActivityAt = this.clock();
  }
}
