import test from "node:test";
import assert from "node:assert/strict";
import { InterimCommitter } from "../src/speech/interim-committer.js";

test("update() commits nothing before the interim crosses flushChars + safetyMarginChars", () => {
  const committer = new InterimCommitter({ flushChars: 10, safetyMarginChars: 2 });
  assert.deepEqual(committer.update("0123456789"), []); // exactly flushChars, below the margin
  assert.deepEqual(committer.update("01234567890"), []); // one short of flushChars+margin (11 < 12)
});

test("update() commits at a sentence boundary within the window when one exists", () => {
  const committer = new InterimCommitter({ flushChars: 12, safetyMarginChars: 2 });
  // "今日は晴れです。" (8 chars incl. 。) sits inside the 12-char window, well ahead of the margin.
  const chunks = committer.update("今日は晴れです。それでですね");
  assert.deepEqual(chunks, ["今日は晴れです。"]);
});

test("update() prefers a soft boundary past 60% of flushChars, else hard-cuts at flushChars", () => {
  // No punctuation at all: findPreferredBreak falls back to a hard cut at maxChars.
  const committer = new InterimCommitter({ flushChars: 10, safetyMarginChars: 0 });
  const chunks = committer.update("abcdefghijklmnop");
  assert.deepEqual(chunks, ["abcdefghij"]);
});

test("safety margin: the trailing safetyMarginChars are never included in a commit", () => {
  const committer = new InterimCommitter({ flushChars: 5, safetyMarginChars: 5 });
  // 10 chars total; only the first 5 (length - margin) are eligible, so exactly one 5-char commit.
  const chunks = committer.update("abcdefghij");
  assert.deepEqual(chunks, ["abcde"]);
  // Nothing beyond it commits without more growth past the margin.
  assert.deepEqual(committer.update("abcdefghij"), []);
});

test("normal extension after a commit yields only the new delta, not a re-commit of the prefix", () => {
  const committer = new InterimCommitter({ flushChars: 10, safetyMarginChars: 0 });
  assert.deepEqual(committer.update("abcdefghij"), ["abcdefghij"]);
  const more = committer.update("abcdefghijklmnopqrst");
  assert.deepEqual(more, ["klmnopqrst"]);
});

test("one update() jump that crosses the threshold twice returns two chunks in order", () => {
  const committer = new InterimCommitter({ flushChars: 10, safetyMarginChars: 0 });
  const chunks = committer.update("abcdefghijklmnopqrst");
  assert.deepEqual(chunks, ["abcdefghij", "klmnopqrst"]);
});

test("a revision that invalidates an already-validated prefix freezes further commits until finalize()", () => {
  const committer = new InterimCommitter({ flushChars: 10, safetyMarginChars: 0 });
  assert.deepEqual(committer.update("abcdefghij"), ["abcdefghij"]); // validates the prefix
  // Chrome revises the transcript to something that no longer starts with it.
  assert.deepEqual(committer.update("xyzdefghijklmnopqrst"), []);
  // finalize() reconciles: only the text beyond the common prefix with what was committed.
  assert.deepEqual(committer.finalize("xyzdefghijklmnopqrst"), ["xyzdefghijklmnopqrst"]);
});

test("finalize() after a frozen (live-contradicted) commit does not resurrect the disproven text as a carry-over", () => {
  const committer = new InterimCommitter({ flushChars: 10, safetyMarginChars: 0 });
  committer.update("abcdefghij"); // committed, validated
  committer.update("xyzdefghijklmnopqrst"); // contradicted -> frozen
  committer.finalize("xyzdefghijklmnopqrst"); // matched=0, no legitimate boundary-shift tail

  // A later, unrelated utterance that happens to start with the same 10
  // characters as the disproven text must still be committed in full — if
  // the stale hypothesis had been resurrected as a carry-over, this
  // coincidental match would look "confirmed" and its first 10 characters
  // would be silently treated as already-sent and never actually submitted
  // (a content-loss bug, not just a duplication one).
  assert.deepEqual(committer.update("abcdefghij klmnopqrst"), ["abcdefghij", "klmnopqrs"]);
});

test("finalize() after commits returns only the true remainder, and resets for the next utterance", () => {
  const committer = new InterimCommitter({ flushChars: 10, safetyMarginChars: 0 });
  committer.update("abcdefghij");
  assert.deepEqual(committer.finalize("abcdefghij final tail"), ["final tail"]);
  // Next utterance starts clean: a short interim below threshold commits nothing.
  assert.deepEqual(committer.update("new"), []);
});

test("finalize() with nothing committed returns the whole final text (parity with pre-9.10 behavior)", () => {
  const committer = new InterimCommitter({ flushChars: 10, safetyMarginChars: 0 });
  assert.deepEqual(committer.finalize("short utterance"), ["short utterance"]);
  assert.deepEqual(committer.finalize("   "), []);
  assert.deepEqual(committer.finalize(""), []);
});

test("punctuation-only chunks and remainders are skipped, but still consumed positionally", () => {
  const committer = new InterimCommitter({ flushChars: 6, safetyMarginChars: 0 });
  // "abcdef" commits normally; the next window is pure punctuation and must not be emitted.
  assert.deepEqual(committer.update("abcdef......"), ["abcdef"]);
  assert.deepEqual(committer.finalize("abcdef......"), []);
});

test("update('') is a no-op, including right after a finalize() that left a carry-over", () => {
  const committer = new InterimCommitter({ flushChars: 4, safetyMarginChars: 0 });
  committer.update("AAAABBBB"); // commits "AAAA", then "BBBB"
  committer.finalize("AAAA"); // final only covers "AAAA" -> "BBBB" carries over, unvalidated
  assert.deepEqual(committer.update(""), []); // SpeechRecognizer fires onInterim("") after every final
  assert.deepEqual(committer.update(null), []);
  assert.deepEqual(committer.update(undefined), []);
});

test("carry-over confirmed in one jump: a commit spanning into the next pending result is honored, not re-sent", () => {
  const committer = new InterimCommitter({ flushChars: 4, safetyMarginChars: 0 });
  assert.deepEqual(committer.update("AAAABBBB"), ["AAAA", "BBBB"]);
  // The final for this result only covers "AAAA" — "BBBB" carries over as an
  // unvalidated hypothesis belonging to the next (still pending) result.
  assert.deepEqual(committer.finalize("AAAA"), []);
  // The next result's interim starts with "BBBB": confirmed, not re-committed.
  assert.deepEqual(committer.update("BBBBCCCC"), ["CCCC"]);
  assert.deepEqual(committer.finalize("BBBBCCCC"), []);
});

test("carry-over confirmed under realistic incremental growth: a shorter-but-consistent interim keeps waiting instead of discarding", () => {
  // Chrome delivers a new result's interim incrementally, usually starting
  // shorter than a carry-over — this must NOT be treated as a contradiction
  // (that was a real bug: it made the "confirmed, not re-sent" guarantee
  // above only work for the unrealistic one-jump delivery pattern).
  const committer = new InterimCommitter({ flushChars: 4, safetyMarginChars: 0 });
  committer.update("AAAABBBB"); // commits "AAAA", then "BBBB"
  committer.finalize("AAAA"); // "BBBB" carries over, unvalidated

  // The next result's interim grows one character at a time, each step a
  // genuine (if incomplete) prefix of the carry-over "BBBB".
  assert.deepEqual(committer.update("B"), []);
  assert.deepEqual(committer.update("BB"), []);
  assert.deepEqual(committer.update("BBB"), []);
  // Reaches "BBBB" exactly: confirms the carry-over, nothing new to commit yet.
  assert.deepEqual(committer.update("BBBB"), []);
  // Grows past it: only the genuinely new tail is committed — "BBBB" itself
  // must not be re-submitted a second time.
  assert.deepEqual(committer.update("BBBBCCCC"), ["CCCC"]);
});

test("carry-over disproved: a fresh utterance that contradicts it starts clean, not permanently frozen", () => {
  const committer = new InterimCommitter({ flushChars: 4, safetyMarginChars: 0 });
  committer.update("AAAABBBB");
  committer.finalize("AAAA"); // "BBBB" carries over, unvalidated
  // The next result turns out to be something unrelated, not "BBBB...".
  assert.deepEqual(committer.update("ZZZZ"), ["ZZZZ"]);
});

test("reset() mid-utterance clears state without emitting anything", () => {
  const committer = new InterimCommitter({ flushChars: 4, safetyMarginChars: 0 });
  committer.update("AAAABBBB");
  committer.reset();
  assert.deepEqual(committer.finalize("AAAABBBB"), ["AAAABBBB"]);
});

test("flushChars: 0 disables update() entirely while finalize() still returns the full text", () => {
  const committer = new InterimCommitter({ flushChars: 0, safetyMarginChars: 0 });
  assert.deepEqual(committer.update("a very long unbroken utterance that would otherwise cross any threshold"), []);
  assert.deepEqual(
    committer.finalize("a very long unbroken utterance that would otherwise cross any threshold"),
    ["a very long unbroken utterance that would otherwise cross any threshold"],
  );
});
