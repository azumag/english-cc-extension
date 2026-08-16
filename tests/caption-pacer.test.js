import test from "node:test";
import assert from "node:assert/strict";
import { CaptionPacer } from "../src/captions/caption-pacer.js";

function fakeOutput(results) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async sendCaption(text, options) {
      calls.push([text, options]);
      const result = results[index] ?? { sent: true };
      index += 1;
      return result;
    },
  };
}

function fakeClockAndWait(startAt = 0) {
  let now = startAt;
  const waits = [];
  return {
    waits,
    clock: () => now,
    wait: async (ms) => {
      waits.push(ms);
      now += ms;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

test("does not wait before the first send", async () => {
  const output = fakeOutput([{ sent: true }]);
  const { clock, wait, waits } = fakeClockAndWait();
  const pacer = new CaptionPacer({ output, intervalMs: 1500, clock, wait });

  const result = await pacer.sendCaption("hello");
  assert.deepEqual(result, { sent: true });
  assert.deepEqual(waits, []);
});

test("waits out the remaining interval before the next send", async () => {
  const output = fakeOutput([{ sent: true }, { sent: true }]);
  const { clock, wait, waits, advance } = fakeClockAndWait();
  const pacer = new CaptionPacer({ output, intervalMs: 1500, clock, wait });

  await pacer.sendCaption("first");
  advance(400); // only 400ms of the 1500ms interval has elapsed
  await pacer.sendCaption("second");

  assert.deepEqual(waits, [1100]);
});

test("does not wait once the interval has already elapsed", async () => {
  const output = fakeOutput([{ sent: true }, { sent: true }]);
  const { clock, wait, waits, advance } = fakeClockAndWait();
  const pacer = new CaptionPacer({ output, intervalMs: 1500, clock, wait });

  await pacer.sendCaption("first");
  advance(2000);
  await pacer.sendCaption("second");

  assert.deepEqual(waits, []);
});

test("intervalMs of 0 disables pacing", async () => {
  const output = fakeOutput([{ sent: true }, { sent: true }]);
  const { clock, wait, waits } = fakeClockAndWait();
  const pacer = new CaptionPacer({ output, intervalMs: 0, clock, wait });

  await pacer.sendCaption("first");
  await pacer.sendCaption("second");

  assert.deepEqual(waits, []);
});

test("a failed send does not push out the next attempt's timing", async () => {
  const output = fakeOutput([{ sent: false, reason: "obs-not-streaming" }, { sent: true }]);
  const { clock, wait, waits } = fakeClockAndWait();
  const pacer = new CaptionPacer({ output, intervalMs: 1500, clock, wait });

  const first = await pacer.sendCaption("first");
  assert.equal(first.sent, false);
  const second = await pacer.sendCaption("second");
  assert.equal(second.sent, true);

  // lastSentAt is still null after a failed send, so the next attempt is
  // not delayed by it.
  assert.deepEqual(waits, []);
});

test("a success following a failure is still paced from the last success, not the failure", async () => {
  const output = fakeOutput([{ sent: true }, { sent: false, reason: "obs-not-streaming" }, { sent: true }]);
  const { clock, wait, waits, advance } = fakeClockAndWait();
  const pacer = new CaptionPacer({ output, intervalMs: 1500, clock, wait });

  await pacer.sendCaption("first"); // succeeds at t=0, lastSentAt=0
  advance(500);
  await pacer.sendCaption("second"); // fails, but still had to wait 1000ms (to t=1500) first
  const third = await pacer.sendCaption("third"); // t is already 1500, satisfying the interval from t=0

  assert.equal(third.sent, true);
  // If the failed "second" call had incorrectly moved the interval baseline
  // to its own (post-wait) clock reading, "third" would wait another
  // 1500ms here. It doesn't wait at all, because lastSentAt is still 0.
  assert.deepEqual(waits, [1000]);
});

test("shouldAbort() checked after the pacing wait short-circuits the send", async () => {
  const output = fakeOutput([{ sent: true }]);
  const { clock, wait, waits, advance } = fakeClockAndWait();
  let aborted = false;
  const pacer = new CaptionPacer({ output, intervalMs: 1500, clock, wait, shouldAbort: () => aborted });

  const first = await pacer.sendCaption("first");
  assert.equal(first.sent, true);

  advance(200);
  aborted = true; // simulates the user stopping CC while this segment waits out the interval
  const second = await pacer.sendCaption("second");

  assert.deepEqual(second, { sent: false, reason: "aborted" });
  assert.equal(output.calls.length, 1); // the aborted send never reaches the wrapped output
  assert.deepEqual(waits, [1300]); // the wait itself still runs before the abort check
});

test("shouldAbort() is honored even on the very first send, when no pacing wait happens", async () => {
  const output = fakeOutput([{ sent: true }]);
  const pacer = new CaptionPacer({ output, intervalMs: 0, shouldAbort: () => true });

  const result = await pacer.sendCaption("hello");
  assert.deepEqual(result, { sent: false, reason: "aborted" });
  assert.equal(output.calls.length, 0);
});

test("passes options through to the wrapped output", async () => {
  const output = fakeOutput([{ sent: true }]);
  const pacer = new CaptionPacer({ output, intervalMs: 0 });

  await pacer.sendCaption("hello", { bypassMicrophoneGate: true });
  assert.deepEqual(output.calls[0], ["hello", { bypassMicrophoneGate: true }]);
});

test("setOutput() rebinds a live pacer to a new output (e.g. after OBS reconnect)", async () => {
  const staleOutput = fakeOutput([{ sent: true }]);
  const freshOutput = fakeOutput([{ sent: true }]);
  const pacer = new CaptionPacer({ output: staleOutput, intervalMs: 0 });

  pacer.setOutput(freshOutput);
  await pacer.sendCaption("hello");

  assert.equal(staleOutput.calls.length, 0);
  assert.equal(freshOutput.calls.length, 1);
});

test("setOutput() rejects a falsy output", () => {
  const pacer = new CaptionPacer({ output: fakeOutput([]), intervalMs: 0 });
  assert.throws(() => pacer.setOutput(null), TypeError);
});

test("reset() clears the interval baseline", async () => {
  const output = fakeOutput([{ sent: true }, { sent: true }]);
  const { clock, wait, waits, advance } = fakeClockAndWait();
  const pacer = new CaptionPacer({ output, intervalMs: 1500, clock, wait });

  await pacer.sendCaption("first");
  advance(200);
  pacer.reset();
  await pacer.sendCaption("second");

  assert.deepEqual(waits, []);
});
