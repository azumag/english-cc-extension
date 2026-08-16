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

  await recognizer.start();
  const recognition = recognizer.recognition;
  assert.equal(recognition.startCount, 1);

  // Repeated transient disconnects (e.g. "network") must keep being retried,
  // with the delay doubling up to a 5s ceiling — never immediately, never unbounded.
  const expectedDelays = [250, 500, 1000, 2000, 4000, 5000, 5000];
  for (const [index, delay] of expectedDelays.entries()) {
    recognition.onerror({ error: "network" });
    recognition.onend();
    t.mock.timers.tick(delay - 1);
    assert.equal(recognition.startCount, index + 1, "must not restart before its scheduled delay elapses");
    t.mock.timers.tick(1);
  }
  assert.equal(recognition.startCount, 1 + expectedDelays.length);
  assert.equal(recognizer.desired, true, "transient errors must not clear desired");

  await recognizer.stop();
  t.mock.timers.tick(6000);
  assert.equal(recognition.startCount, 1 + expectedDelays.length, "stop() must cancel any pending restart");
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
