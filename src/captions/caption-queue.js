export class CaptionQueue {
  constructor({
    processor,
    maxPending = 2,
    maxAgeMs = 5000,
    clock = () => Date.now(),
    onDrop = () => {},
    onState = () => {},
  } = {}) {
    if (typeof processor !== "function") throw new TypeError("CaptionQueue requires a processor");
    this.processor = processor;
    this.maxPending = maxPending;
    this.maxAgeMs = maxAgeMs;
    this.clock = clock;
    this.onDrop = onDrop;
    this.onState = onState;
    this.pending = [];
    this.active = false;
    this.disposed = false;
    this.sequence = 0;
    this.idleResolvers = new Set();
  }

  submit({ text, createdAt = this.clock(), id } = {}) {
    if (this.disposed) return false;
    const normalized = String(text ?? "").trim();
    if (!normalized) return false;

    const item = {
      id: id ?? `caption-${++this.sequence}`,
      text: normalized,
      createdAt,
    };

    if (this.pending.length >= this.maxPending) {
      const dropped = this.pending.shift();
      this.onDrop(dropped, "overflow");
    }
    this.pending.push(item);
    this.#emitState();
    void this.#drain();
    return true;
  }

  clear(reason = "cleared") {
    const dropped = this.pending.splice(0);
    for (const item of dropped) this.onDrop(item, reason);
    this.#emitState();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clear("disposed");
    this.#resolveIdleIfNeeded();
  }

  whenIdle() {
    if (!this.active && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.add(resolve));
  }

  async #drain() {
    if (this.active || this.disposed) return;
    this.active = true;
    this.#emitState();
    try {
      while (!this.disposed && this.pending.length) {
        const item = this.pending.shift();
        if (this.clock() - item.createdAt > this.maxAgeMs) {
          this.onDrop(item, "expired");
          continue;
        }
        try {
          await this.processor(item);
        } catch (error) {
          this.onDrop(item, "processor-error", error);
        }
      }
    } finally {
      this.active = false;
      this.#emitState();
      this.#resolveIdleIfNeeded();
    }
  }

  #emitState() {
    this.onState({ active: this.active, pending: this.pending.length, disposed: this.disposed });
  }

  #resolveIdleIfNeeded() {
    if (this.active || this.pending.length) return;
    for (const resolve of this.idleResolvers) resolve();
    this.idleResolvers.clear();
  }
}
