export class ChromeTranslator {
  constructor({
    sourceLanguage = "ja",
    targetLanguage = "en",
    globalScope = globalThis,
    onStatus = () => {},
  } = {}) {
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.globalScope = globalScope;
    this.onStatus = onStatus;
    this.translator = null;
    this.initializing = null;
  }

  get supported() {
    return Boolean(this.globalScope.Translator?.create);
  }

  async availability() {
    if (!this.supported) return "unavailable";
    if (typeof this.globalScope.Translator.availability !== "function") return "unknown";
    return this.globalScope.Translator.availability({
      sourceLanguage: this.sourceLanguage,
      targetLanguage: this.targetLanguage,
    });
  }

  async initialize() {
    if (this.translator) return this.translator;
    if (this.initializing) return this.initializing;
    if (!this.supported) throw new Error("Chrome Translator API is unavailable");

    this.onStatus({ state: "initializing" });
    this.initializing = this.globalScope.Translator.create({
      sourceLanguage: this.sourceLanguage,
      targetLanguage: this.targetLanguage,
      monitor: (monitor) => {
        monitor.addEventListener("downloadprogress", (event) => {
          const loaded = Number(event.loaded ?? 0);
          const total = Number(event.total ?? 1);
          this.onStatus({
            state: "downloading",
            progress: total > 0 ? Math.max(0, Math.min(1, loaded / total)) : 0,
          });
        });
      },
    }).then((translator) => {
      this.translator = translator;
      this.onStatus({ state: "ready" });
      return translator;
    }).catch((error) => {
      this.onStatus({ state: "error", error });
      throw error;
    }).finally(() => {
      this.initializing = null;
    });

    return this.initializing;
  }

  async translate(text) {
    const input = String(text ?? "").trim();
    if (!input) throw new TypeError("Translation input is empty");
    const translator = await this.initialize();
    const result = await translator.translate(input);
    const translated = String(result ?? "").trim();
    if (!translated) throw new Error("Chrome Translator returned an empty result");
    return translated;
  }

  destroy() {
    try { this.translator?.destroy?.(); } catch {}
    this.translator = null;
    this.initializing = null;
    this.onStatus({ state: "idle" });
  }
}
