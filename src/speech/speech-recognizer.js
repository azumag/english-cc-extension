function recognitionConstructor(globalScope) {
  return globalScope.SpeechRecognition ?? globalScope.webkitSpeechRecognition ?? null;
}

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
      this.onError(new Error(`Speech recognition error: ${error}`));
      this.onState({ state: "error", error });
    };

    this.recognition.onend = () => {
      this.active = false;
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
