const SENTENCE_BOUNDARY = /[。！？.!?]/u;
const SOFT_BOUNDARY = /[、,，;；:：\s]/u;

function findPreferredBreak(text, maxChars) {
  let sentenceBreak = -1;
  let softBreak = -1;
  const limit = Math.min(text.length, maxChars);

  for (let index = 0; index < limit; index += 1) {
    const char = text[index];
    if (SENTENCE_BOUNDARY.test(char)) sentenceBreak = index + 1;
    else if (SOFT_BOUNDARY.test(char)) softBreak = index + 1;
  }

  if (sentenceBreak > 0) return sentenceBreak;
  if (softBreak >= Math.ceil(maxChars * 0.6)) return softBreak;
  return maxChars;
}

export function segmentSourceText(value, maxChars = 40) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return [];
  if (!Number.isInteger(maxChars) || maxChars < 1 || text.length <= maxChars) return [text];

  const segments = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const cut = findPreferredBreak(remaining, maxChars);
    const segment = remaining.slice(0, cut).trim();
    if (segment) segments.push(segment);
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) segments.push(remaining.trim());
  return segments;
}

export class CaptionQueue {
  constructor({
    processor,
    maxPending = 2,
    maxAgeMs = 5000,
    sourceChunkChars = 40,
    segmenter = segmentSourceText,
    clock = () => Date.now(),
    onDrop = () => {},
    onState = () => {},
  } = {}) {
    if (typeof processor !== "function") throw new TypeError("CaptionQueue requires a processor");
    if (typeof segmenter !== "function") throw new TypeError("CaptionQueue segmenter must be a function");
    this.processor = processor;
    this.maxPending = maxPending;
    this.maxAgeMs = maxAgeMs;
    this.sourceChunkChars = sourceChunkChars;
    this.segmenter = segmenter;
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
          const segments = this.segmenter(item.text, this.sourceChunkChars);
          const parts = segments.length ? segments : [item.text];
          for (let index = 0; index < parts.length && !this.disposed; index += 1) {
            await this.processor({
              ...item,
              text: parts[index],
              segmentIndex: index,
              segmentCount: parts.length,
            });
          }
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
