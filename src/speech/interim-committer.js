import { findPreferredBreak } from "../captions/caption-queue.js";

// The Web Speech API only calls SpeechRecognizer's onFinal once Chrome's
// own speech engine decides an utterance is "final" (its pause/VAD
// detection — not something this extension controls or can force). For one
// long, unbroken sentence, that can take a long time, so nothing reaches
// translation until it finally settles (see docs/HANDOFF.md 9.10).
//
// InterimCommitter proactively "commits" (submits downstream) leading
// chunks of the still-growing INTERIM text once they cross flushChars, so
// translation can start well before Chrome finalizes the utterance. This is
// a deliberate latency/accuracy tradeoff: interim text can be revised by
// Chrome as more audio is decoded, and an already-committed chunk can never
// be un-sent. To bound that risk, the trailing safetyMarginChars of the
// interim text are never eligible for commit (that's the part most likely
// to change next), and finalize() reconciles the true remainder once Chrome
// settles, so only genuinely new text gets submitted a second time.
//
// State model: committedText is the exact prefix of the current
// utterance's interim text already committed. validated tracks whether
// that prefix has been confirmed against a live interim (true) or is an
// unvalidated hypothesis carried over from a prior finalize() call whose
// final text didn't fully absorb what had been committed (see finalize()).
// A fresh interim that's merely SHORTER than an unvalidated carry-over
// (but still consistent with it so far) is neither confirmation nor
// contradiction — Chrome delivers a new result's interim incrementally, so
// this is expected and update() just keeps waiting. Only a genuine mismatch
// discards the hypothesis, so a rare deep revision can never permanently
// poison commits for later utterances. frozen marks that a validated
// (already-sent) prefix was actively contradicted by a live interim; when
// finalize() runs on a frozen commit, any leftover tail is known-stale and
// is dropped rather than carried over as if it were a legitimate
// boundary-shift guess.
//
// Pure and dependency-free by design (see src/captions/caption-pacer.js /
// src/permission/mic-permission-flow.js for the same convention) — all
// browser/DOM/chrome.* glue lives in src/sidepanel/sidepanel.js instead.

const SUBSTANTIVE_TEXT = /[\p{L}\p{N}]/u;

function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index += 1;
  return index;
}

export class InterimCommitter {
  constructor({ flushChars = 40, safetyMarginChars = 10 } = {}) {
    this.flushChars = flushChars;
    this.safetyMarginChars = safetyMarginChars;
    this.committedText = "";
    this.validated = false;
    this.frozen = false;
  }

  // Call on every onInterim(text). Returns the (usually 0 or 1, occasionally
  // more) new chunks to submit downstream, in order.
  update(interimText) {
    if (this.flushChars <= 0) return [];
    const interim = String(interimText ?? "").trim();
    if (!interim) return []; // SpeechRecognizer also fires onInterim("") after a final/stop; not a revision signal.

    if (this.committedText) {
      if (interim.startsWith(this.committedText)) {
        this.validated = true;
        this.frozen = false;
      } else if (this.validated) {
        // Already-submitted text now contradicts the live interim. Don't
        // commit anything further this utterance; finalize() reconciles
        // once Chrome settles on the real text.
        this.frozen = true;
        return [];
      } else if (this.committedText.startsWith(interim)) {
        // An unvalidated carry-over hypothesis, but this fresh interim just
        // hasn't grown far enough yet to confirm or contradict it — Chrome
        // delivers a new result's interim incrementally, often starting
        // shorter than the carry-over itself. Keep waiting rather than
        // discarding a guess that hasn't actually been disproved.
        return [];
      } else {
        // Genuinely contradicted (not merely shorter-so-far) — an
        // unvalidated carry-over hypothesis from a prior finalize() was
        // disproved by this fresh interim, new utterance, start clean.
        this.committedText = "";
      }
    }

    const chunks = [];
    const stableEnd = interim.length - this.safetyMarginChars;
    while (stableEnd - this.committedText.length >= this.flushChars) {
      const remaining = interim.slice(this.committedText.length, stableEnd);
      const cut = findPreferredBreak(remaining, this.flushChars);
      const piece = remaining.slice(0, cut);
      this.committedText += piece;
      // Freshly derived from this call's live interim text, so it's
      // trustworthy the same way a startsWith-confirmed prefix is above —
      // without this, a commit made while committedText started empty
      // would leave `validated` false and a later contradicting interim
      // would wrongly discard (instead of freeze) already-sent text.
      this.validated = true;
      const trimmed = piece.trim();
      if (trimmed && SUBSTANTIVE_TEXT.test(trimmed)) chunks.push(trimmed);
    }
    return chunks;
  }

  // Call on every onFinal(text). Resets per-utterance state and returns the
  // remainder beyond whatever was already committed (0 or 1 chunk) — the
  // only part that still needs to be submitted downstream. When nothing was
  // committed this returns the whole final text, i.e. today's behavior
  // unchanged for utterances that never crossed the threshold.
  finalize(finalText) {
    const final = String(finalText ?? "").trim();
    const committed = this.committedText;
    const wasFrozen = this.frozen;
    this.committedText = "";
    this.validated = false;
    this.frozen = false;

    if (!committed) {
      return final && SUBSTANTIVE_TEXT.test(final) ? [final] : [];
    }

    const matched = commonPrefixLength(committed, final);
    const remainder = final.slice(matched).trim();

    if (!wasFrozen) {
      // The tail of what we committed that the final text didn't absorb —
      // it most likely belongs to the NEXT utterance's interim (Chrome
      // placed the boundary earlier than we guessed), not text that was
      // actually wrong. Carried over as an unvalidated hypothesis; the next
      // update() confirms or discards it.
      const carryOver = committed.slice(matched).trimStart();
      if (carryOver) this.committedText = carryOver;
    }
    // If it WAS frozen, the committed prefix was already actively
    // contradicted by a live interim before finalize() ran — any leftover
    // tail is stale/disproven, not a legitimate boundary-shift carry-over,
    // so it's dropped instead of resurrected as a hypothesis for whatever
    // starts next.

    return remainder && SUBSTANTIVE_TEXT.test(remainder) ? [remainder] : [];
  }

  // Drops all in-progress commit state without emitting anything, e.g. when
  // SpeechRecognizer stops/restarts/errors — Chrome never finalizes across
  // a restart, so already-committed chunks stand (an improvement: today the
  // whole unfinalized utterance would just be lost) but the unstable
  // uncommitted tail cannot be recovered and must not bleed into whatever
  // starts next.
  reset() {
    this.committedText = "";
    this.validated = false;
    this.frozen = false;
  }
}
