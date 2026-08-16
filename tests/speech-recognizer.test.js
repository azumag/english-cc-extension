import test from "node:test";
import assert from "node:assert/strict";
import { SpeechRecognizer } from "../src/speech/speech-recognizer.js";

function createFakeStream() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  return {
    tracks: [track],
    getTracks() { return this.tracks; },
    getAudioTracks() { return this.tracks; },
  };
}

class FakeRecognition {
  constructor() {
    this.startCount = 0;
    this.aborted = false;
    this.stopped = false;
    this.quality = undefined;
    this.unspokenPunctuation = undefined;
  }
  start() { this.startCount += 1; }
  stop() { this.stopped = true; }
  abort() { this.aborted = true; }
}

// Simulates an older Chrome whose SpeechRecognition exposes neither the
// `quality` nor the `unspokenPunctuation` attribute.
class LegacyFakeRecognition {
  constructor() {
    this.startCount = 0;
  }
  start() { this.startCount += 1; }
  stop() {}
  abort() {}
}

function createHarness() {
  const globalScope = { SpeechRecognition: FakeRecognition };
  const mediaDevices = { async getUserMedia() { return createFakeStream(); } };
  return { globalScope, mediaDevices };
}

async function flushMicrotasks() {
  // Restart recovery awaits through several layers (#restartNow ->
  // #ensureUsableStream -> #acquireStream -> getUserMedia), so flush enough
  // microtask turns for the deepest chain to settle.
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

test("stops retrying after a fatal error (not-allowed) and releases the mic", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { globalScope, mediaDevices } = createHarness();
  const states = [];
  const errors = [];
  const recognizer = new SpeechRecognizer({
    globalScope,
    mediaDevices,
    onState: (status) => states.push(status),
    onError: (error) => errors.push(error.message),
  });

  await recognizer.start();
  const recognition = recognizer.recognition;
  const stream = recognizer.stream;
  assert.equal(recognition.startCount, 1);

  recognition.onerror({ error: "not-allowed" });
  recognition.onend();

  assert.equal(recognizer.desired, false, "desired must be cleared so no more restarts are scheduled");
  assert.equal(recognizer.stream, null, "mic stream reference must be released");
  assert.equal(stream.tracks[0].stopped, true, "mic track must be stopped");
  assert.deepEqual(states.at(-1), { state: "fatal-error", error: "not-allowed" });
  assert.equal(errors.at(-1), "Speech recognition error: not-allowed");

  // Even after waiting past the max backoff window, start() must not be retried.
  t.mock.timers.tick(6000);
  assert.equal(recognition.startCount, 1, "start() must not be retried after a fatal error");
});

test("service-not-allowed and language-not-supported are also treated as fatal", async (t) => {
  for (const fatalError of ["service-not-allowed", "language-not-supported"]) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { globalScope, mediaDevices } = createHarness();
    const states = [];
    const recognizer = new SpeechRecognizer({ globalScope, mediaDevices, onState: (status) => states.push(status) });

    await recognizer.start();
    const recognition = recognizer.recognition;
    recognition.onerror({ error: fatalError });
    recognition.onend();

    assert.equal(recognizer.desired, false, `${fatalError} must stop the retry loop`);
    t.mock.timers.tick(6000);
    assert.equal(recognition.startCount, 1, `${fatalError} must not trigger a restart`);
    t.mock.timers.reset();
  }
});

test("transient errors keep retrying with a capped exponential backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { globalScope, mediaDevices } = createHarness();
  const recognizer = new SpeechRecognizer({ globalScope, mediaDevices });
  t.after(() => recognizer.stop());

  await recognizer.start();
  assert.equal(recognizer.recognition.startCount, 1);

  // Repeated transient disconnects (e.g. "network") must keep being retried,
  // with the delay doubling up to a 5s ceiling, and each restart must build
  // a fresh recognition instance (never reuse a stuck one).
  const expectedDelays = [250, 500, 1000, 2000, 4000, 5000, 5000];
  for (const delay of expectedDelays) {
    const current = recognizer.recognition;
    assert.ok(current, "recognition instance must exist before ending the session");
    current.onerror({ error: "network" });
    current.onend();
    t.mock.timers.tick(delay - 1);
    assert.equal(recognizer.recognition, null, "must not restart before its scheduled delay elapses");
    t.mock.timers.tick(1);
    await flushMicrotasks();
    assert.ok(recognizer.recognition, "must restart after its scheduled delay elapses");
    assert.equal(recognizer.recognition.startCount, 1, "fresh instance must start exactly once");
  }
  assert.equal(recognizer.desired, true, "transient errors must not clear desired");

  await recognizer.stop();
  t.mock.timers.tick(6000);
  assert.equal(recognizer.recognition, null, "stop() must cancel any pending restart");
});

test("builds a fresh recognition instance on every restart", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { globalScope, mediaDevices } = createHarness();
  const recognizer = new SpeechRecognizer({ globalScope, mediaDevices });
  t.after(() => recognizer.stop());

  await recognizer.start();
  const first = recognizer.recognition;
  first.onend();
  t.mock.timers.tick(250);
  await flushMicrotasks();

  assert.ok(recognizer.recognition, "restart must create a new instance");
  assert.notEqual(recognizer.recognition, first, "the old instance must be discarded");
  assert.equal(recognizer.recognition.startCount, 1);
  await recognizer.stop();
});

test("re-acquires the microphone when the track has ended", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let getUserMediaCalls = 0;
  const mediaDevices = {
    async getUserMedia() {
      getUserMediaCalls += 1;
      return createFakeStream();
    },
  };
  const recognizer = new SpeechRecognizer({ globalScope: { SpeechRecognition: FakeRecognition }, mediaDevices });
  t.after(() => recognizer.stop());

  await recognizer.start();
  assert.equal(getUserMediaCalls, 1);
  recognizer.stream.tracks[0].readyState = "ended";
  recognizer.recognition.onend();
  t.mock.timers.tick(250);
  await flushMicrotasks();

  assert.equal(getUserMediaCalls, 2, "an ended track must trigger getUserMedia again");
  assert.notEqual(recognizer.stream.tracks[0].readyState, "ended");
  assert.equal(recognizer.recognition.startCount, 1);
  await recognizer.stop();
});

test("retries a start() that throws on a short capped schedule", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { mediaDevices } = createHarness();
  let startAttempts = 0;
  const FlakyRecognition = class {
    constructor() { this.startCount = 0; }
    start() {
      startAttempts += 1;
      if (startAttempts === 1) {
        this.startCount += 1;
        return;
      }
      const error = new Error("recognition has already started");
      error.name = "InvalidStateError";
      throw error;
    }
    stop() {}
    abort() {}
  };
  const errors = [];
  const recognizer = new SpeechRecognizer({
    globalScope: { SpeechRecognition: FlakyRecognition },
    mediaDevices,
    onError: (error) => errors.push(error.message),
  });
  t.after(() => recognizer.stop());

  await recognizer.start();
  assert.equal(startAttempts, 1);

  recognizer.recognition.onend();
  t.mock.timers.tick(250);
  await flushMicrotasks();
  assert.equal(startAttempts, 2, "first restart attempt must happen after the 250ms onend backoff");

  // Subsequent failures retry at 500ms -> 1000ms -> 2000ms cap, and stay at
  // the 2000ms cap instead of growing toward the 5s onend ceiling.
  t.mock.timers.tick(500);
  await flushMicrotasks();
  assert.equal(startAttempts, 3);
  t.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.equal(startAttempts, 4);
  t.mock.timers.tick(2000);
  await flushMicrotasks();
  assert.equal(startAttempts, 5, "retries must cap at 2000ms");
  t.mock.timers.tick(1999);
  await flushMicrotasks();
  assert.equal(startAttempts, 5, "retry must wait the full 2000ms");
  t.mock.timers.tick(1);
  await flushMicrotasks();
  assert.equal(startAttempts, 6, "retries must continue at the 2000ms cap, not grow to 5000ms");
  assert.equal(recognizer.desired, true, "start() failures must not stop the recognizer");
  assert.ok(errors.length >= 4, "start() failures must be reported through onError");
  await recognizer.stop();
});

test("treats aborted errors while running as a quiet restart", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { globalScope, mediaDevices } = createHarness();
  const states = [];
  const errors = [];
  const recognizer = new SpeechRecognizer({
    globalScope,
    mediaDevices,
    onState: (status) => states.push(status),
    onError: (error) => errors.push(error.message),
  });
  t.after(() => recognizer.stop());

  await recognizer.start();
  const first = recognizer.recognition;
  first.onerror({ error: "aborted" });
  assert.equal(errors.length, 0, "aborted must not surface as a user-facing error");
  assert.deepEqual(states.at(-1), { state: "restarting", error: "aborted" });

  first.onend();
  t.mock.timers.tick(250);
  await flushMicrotasks();
  assert.ok(recognizer.recognition && recognizer.recognition !== first, "aborted sessions must restart");
  await recognizer.stop();
});

test("watchdog restarts a session that stopped silently", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { globalScope, mediaDevices } = createHarness();
  const states = [];
  let now = 1000;
  const recognizer = new SpeechRecognizer({
    globalScope,
    mediaDevices,
    silenceLimitMs: 50,
    watchdogIntervalMs: 10,
    clock: () => now,
    onState: (status) => states.push(status),
  });
  t.after(() => recognizer.stop());

  await recognizer.start();
  const first = recognizer.recognition;
  now += 200; // No results arrive; the silence limit (50ms) is long exceeded.
  t.mock.timers.tick(10);
  await flushMicrotasks();

  assert.notEqual(recognizer.recognition, first, "watchdog must force a clean restart");
  assert.deepEqual(states.at(-1), { state: "restarting", error: "watchdog-timeout" });
  await recognizer.stop();
});

test("applies quality mode and unspoken punctuation when Chrome exposes them", async () => {
  const { globalScope, mediaDevices } = createHarness();
  const recognizer = new SpeechRecognizer({
    globalScope,
    mediaDevices,
    quality: "conversation",
    unspokenPunctuation: true,
  });

  await recognizer.start();
  assert.equal(recognizer.recognition.quality, "conversation");
  assert.equal(recognizer.recognition.unspokenPunctuation, true);
  await recognizer.stop();
});

test("ignores quality and punctuation settings on Chrome builds without them", async () => {
  const globalScope = { SpeechRecognition: LegacyFakeRecognition };
  const mediaDevices = { async getUserMedia() { return createFakeStream(); } };
  const recognizer = new SpeechRecognizer({
    globalScope,
    mediaDevices,
    quality: "dictation",
    unspokenPunctuation: true,
  });

  await recognizer.start();
  assert.equal(recognizer.recognition.startCount, 1, "start() must succeed on legacy Chrome");
  await recognizer.stop();
});

test("requests gain-normalized mono audio for recognition", async () => {
  let captured = null;
  const mediaDevices = {
    async getUserMedia(constraints) { captured = constraints; return createFakeStream(); },
  };
  const recognizer = new SpeechRecognizer({ globalScope: { SpeechRecognition: FakeRecognition }, mediaDevices });

  await recognizer.start();
  assert.equal(captured.audio.autoGainControl, true, "AGC must stay on so quiet mics are audible");
  assert.equal(captured.audio.channelCount, 1, "recognition wants a single channel");
  assert.equal(captured.audio.echoCancellation, true);
  assert.equal(captured.audio.noiseSuppression, true);
  await recognizer.stop();
});
