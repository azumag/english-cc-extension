function defaultWait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wraps an ObsCaptionOutput-compatible sender so that consecutive captions
// (segments of one long utterance, or back-to-back utterances) are not
// pushed to Twitch faster than a viewer could plausibly read the previous
// one. Twitch CC replaces the on-screen caption instead of queuing it, so
// sending segments back to back makes every segment but the last unreadable
// (see docs/HANDOFF.md 9.4).
//
// The interval is measured from the last *successful* send, not from the
// last attempt, so a rejected/failed segment does not itself delay the next
// try. `clock` and `wait` are injectable so tests never need a real sleep.
export class CaptionPacer {
  constructor({ output, intervalMs = 0, clock = () => Date.now(), wait = defaultWait, shouldAbort = () => false } = {}) {
    if (!output) throw new TypeError("CaptionPacer requires an output");
    this.output = output;
    this.intervalMs = intervalMs;
    this.clock = clock;
    this.wait = wait;
    this.shouldAbort = shouldAbort;
    this.lastSentAt = null;
  }

  // Rebinds the wrapped output, e.g. after a manual OBS reconnect swaps in a
  // fresh ObsCaptionOutput. Without this, a pacer created before the
  // reconnect would keep sending to the stale (now-disconnected) output.
  setOutput(output) {
    if (!output) throw new TypeError("CaptionPacer requires an output");
    this.output = output;
  }

  async sendCaption(text, options) {
    if (this.intervalMs > 0 && this.lastSentAt !== null) {
      const remaining = this.intervalMs - (this.clock() - this.lastSentAt);
      if (remaining > 0) await this.wait(remaining);
    }

    // shouldAbort is re-checked after the wait (not just by the caller
    // before calling sendCaption) because the wait itself can take up to
    // intervalMs: without this, stopping mid-wait would still let one
    // caption reach OBS well after the user asked to stop.
    if (this.shouldAbort()) return { sent: false, reason: "aborted" };

    const result = await this.output.sendCaption(text, options);
    if (result.sent) this.lastSentAt = this.clock();
    return result;
  }

  reset() {
    this.lastSentAt = null;
  }
}
