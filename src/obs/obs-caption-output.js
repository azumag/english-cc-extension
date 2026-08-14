export class ObsCaptionOutput {
  constructor({ client, microphoneInputName = "" } = {}) {
    if (!client) throw new TypeError("ObsCaptionOutput requires an OBS client");
    this.client = client;
    this.microphoneInputName = String(microphoneInputName ?? "").trim();
    this.initialized = false;
    this.version = null;
  }

  async initialize() {
    this.version = await this.client.request("GetVersion");
    const availableRequests = Array.isArray(this.version.availableRequests)
      ? this.version.availableRequests
      : [];
    if (!availableRequests.includes("SendStreamCaption")) {
      throw new Error("This OBS WebSocket version does not support SendStreamCaption");
    }
    this.initialized = true;
    return this.version;
  }

  async status() {
    if (!this.client.connected) return { connected: false, streaming: false, microphoneMuted: null };
    const stream = await this.client.request("GetStreamStatus");
    let microphoneMuted = null;
    if (this.microphoneInputName) {
      const input = await this.client.request("GetInputMute", { inputName: this.microphoneInputName });
      microphoneMuted = Boolean(input.inputMuted);
    }
    return {
      connected: true,
      streaming: Boolean(stream.outputActive),
      microphoneMuted,
    };
  }

  async sendCaption(text, { bypassMicrophoneGate = false } = {}) {
    const captionText = String(text ?? "").trim();
    if (!captionText) return { sent: false, reason: "empty" };
    if (!this.client.connected) return { sent: false, reason: "obs-disconnected" };
    if (!this.initialized) await this.initialize();

    const stream = await this.client.request("GetStreamStatus");
    if (!stream.outputActive) return { sent: false, reason: "obs-not-streaming" };

    if (this.microphoneInputName && !bypassMicrophoneGate) {
      const input = await this.client.request("GetInputMute", { inputName: this.microphoneInputName });
      if (input.inputMuted) return { sent: false, reason: "microphone-muted" };
    }

    await this.client.request("SendStreamCaption", { captionText });
    return { sent: true };
  }
}
