function recognitionConstructor(globalScope) {
  return globalScope.SpeechRecognition ?? globalScope.webkitSpeechRecognition ?? null;
}

// Errors the Web Speech API defines as unrecoverable without user action
// (permission grant, browser settings, or picking a supported language).
// Retrying start() after these fires the same rejection forever, so we
// stop instead of scheduling another restart.
// https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognitionError/error
const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "language-not-supported"]);

export class SpeechRecognizer {
  constructor({
    lang = "ja-JP",
    globalScope = globalThis,
    mediaDevices = globalThis.navigator?.mediaDevices,
    onInterim = () => {},
    onFinal = () => {},
    onState = () => {},
    onError = () => {},
  } = {}) {
    this.lang = lang;
    this.globalScope = globalScope;
    this.mediaDevices = mediaDevices;
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onState = onState;
    this.onError = onError;
    this.recognition = null;
    this.stream = null;
    this.desired = false;
    this.active = false;
    this.restartTimer = null;
    this.restartDelayMs = 250;
    this.inputMode = "unknown";
    this.fatalError = null;
  }

  probe() {
    return {
      speechRecognition: Boolean(recognitionConstructor(this.globalScope)),
      mediaDevices: Boolean(this.mediaDevices?.getUserMedia && this.mediaDevices?.enumerateDevices),
      localRecognitionProperty: Boolean(recognitionConstructor(this.globalScope)?.prototype && "processLocally" in recognitionConstructor(this.globalScope).prototype),
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
    this.restartDelayMs = 250;
    this.fatalError = null;
    try {
      this.stream = await this.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      });
    } catch (error) {
      this.desired = false;
      this.onState({ state: "error", error: "microphone-permission" });
      throw error;
    }

    this.recognition = new Recognition();
    this.recognition.lang = this.lang;
    this.recognition.continuous = true;
    this.recognition.interimResults = true;

    this.recognition.onstart = () => {
      this.active = true;
      this.restartDelayMs = 250;
      this.onState({ state: "recognizing", inputMode: this.inputMode });
    };

    this.recognition.onresult = (event) => {
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

    this.recognition.onerror = (event) => {
      const error = String(event.error ?? "unknown");
      if (!this.desired && error === "aborted") return;
      if (FATAL_ERRORS.has(error)) {
        this.fatalError = error;
        this.desired = false;
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      this.onError(new Error(`Speech recognition error: ${error}`));
      this.onState({ state: this.fatalError ? "fatal-error" : "error", error });
    };

    this.recognition.onend = () => {
      this.active = false;
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

    try {
      this.#startRecognition();
    } catch (error) {
      this.desired = false;
      this.stream?.getTracks().forEach((track) => track.stop());
      this.stream = null;
      this.recognition = null;
      throw error;
    }
  }

  async stop() {
    this.desired = false;
    this.fatalError = null;
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
    this.restartDelayMs = Math.min(5000, this.restartDelayMs * 2);
    this.restartTimer = setTimeout(() => {
      if (!this.desired) return;
      try {
        this.#startRecognition();
      } catch (error) {
        this.onError(error);
        this.#scheduleRestart();
      }
    }, delay);
  }
}
