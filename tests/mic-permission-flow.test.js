import test from "node:test";
import assert from "node:assert/strict";
import {
  awaitHelperCompletion,
  buildHelperResultMessage,
  decideMicPermissionAction,
  helperErrorLabel,
  isMicPermissionResultMessage,
  queryMicrophonePermission,
  requestMicrophoneOnce,
  shouldOpenHelperAfterFailure,
} from "../src/permission/mic-permission-flow.js";

function createFakeStream() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  return {
    tracks: [track],
    getTracks() { return this.tracks; },
  };
}

test("decideMicPermissionAction maps permission states to the right action", () => {
  assert.equal(decideMicPermissionAction("granted"), "request-direct");
  assert.equal(decideMicPermissionAction("prompt"), "open-helper");
  assert.equal(decideMicPermissionAction("denied"), "explain-denied");
  assert.equal(decideMicPermissionAction("unsupported"), "request-direct");
  assert.equal(decideMicPermissionAction("some-garbage-value"), "request-direct");
});

test("shouldOpenHelperAfterFailure only opens the helper for the side-panel auto-deny bug case", () => {
  assert.equal(shouldOpenHelperAfterFailure({ permissionState: "prompt", errorName: "NotAllowedError" }), true);
  assert.equal(shouldOpenHelperAfterFailure({ permissionState: "unsupported", errorName: "NotAllowedError" }), true);
  // Already "granted" + NotAllowedError means an OS-level block a helper tab can't fix.
  assert.equal(shouldOpenHelperAfterFailure({ permissionState: "granted", errorName: "NotAllowedError" }), false);
  assert.equal(shouldOpenHelperAfterFailure({ permissionState: "unsupported", errorName: "NotFoundError" }), false);
});

test("queryMicrophonePermission reads the injected Permissions API result", async () => {
  let queriedWith = null;
  const permissions = {
    async query(descriptor) {
      queriedWith = descriptor;
      return { state: "prompt" };
    },
  };
  assert.equal(await queryMicrophonePermission(permissions), "prompt");
  assert.deepEqual(queriedWith, { name: "microphone" });
});

test("queryMicrophonePermission falls back to unsupported when query throws", async () => {
  const permissions = { async query() { throw new TypeError("unsupported PermissionName"); } };
  assert.equal(await queryMicrophonePermission(permissions), "unsupported");
});

test("queryMicrophonePermission falls back to unsupported without a Permissions API", async () => {
  assert.equal(await queryMicrophonePermission(undefined), "unsupported");
});

test("queryMicrophonePermission falls back to unsupported for an unrecognized state", async () => {
  const permissions = { async query() { return { state: "something-new" }; } };
  assert.equal(await queryMicrophonePermission(permissions), "unsupported");
});

test("requestMicrophoneOnce grants and immediately releases the mic", async () => {
  const stream = createFakeStream();
  const mediaDevices = { async getUserMedia() { return stream; } };
  const result = await requestMicrophoneOnce(mediaDevices);
  assert.deepEqual(result, { ok: true });
  assert.equal(stream.tracks[0].stopped, true, "mic must be released immediately after the grant");
});

test("requestMicrophoneOnce reports the rejection's error name", async () => {
  const mediaDevices = { async getUserMedia() { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); } };
  assert.deepEqual(await requestMicrophoneOnce(mediaDevices), { ok: false, errorName: "NotAllowedError" });
});

test("requestMicrophoneOnce fails closed when mediaDevices is unavailable", async () => {
  assert.deepEqual(await requestMicrophoneOnce(undefined), { ok: false, errorName: "MediaDevicesUnavailable" });
});

test("buildHelperResultMessage / isMicPermissionResultMessage round-trip", () => {
  assert.deepEqual(buildHelperResultMessage({ ok: true }), { type: "mic-permission-result", granted: true, errorName: null });
  assert.deepEqual(
    buildHelperResultMessage({ ok: false, errorName: "NotAllowedError" }),
    { type: "mic-permission-result", granted: false, errorName: "NotAllowedError" },
  );

  assert.equal(isMicPermissionResultMessage(buildHelperResultMessage({ ok: true })), true);
  assert.equal(isMicPermissionResultMessage(null), false);
  assert.equal(isMicPermissionResultMessage("junk"), false);
  assert.equal(isMicPermissionResultMessage({}), false);
  assert.equal(isMicPermissionResultMessage({ type: "other" }), false);
});

test("buildHelperResultMessage defaults a missing errorName on failure", () => {
  assert.deepEqual(buildHelperResultMessage({ ok: false }), { type: "mic-permission-result", granted: false, errorName: "UnknownError" });
});

test("helperErrorLabel gives distinct, identifiable copy per error", () => {
  assert.match(helperErrorLabel("SomeUnknownError"), /SomeUnknownError/);
  assert.notEqual(helperErrorLabel("NotAllowedError"), helperErrorLabel("NotFoundError"));
});

function neverWait() {
  return new Promise(() => {});
}

test("awaitHelperCompletion resolves granted on a matching message and unsubscribes", async () => {
  let handler = null;
  let unsubscribed = false;
  const subscribe = (h) => { handler = h; return () => { unsubscribed = true; }; };

  const promise = awaitHelperCompletion({ isClosed: () => false, subscribe, wait: neverWait });
  handler({ type: "mic-permission-result", granted: true, errorName: null });

  assert.deepEqual(await promise, { outcome: "granted" });
  assert.equal(unsubscribed, true);
});

test("awaitHelperCompletion ignores unrelated messages before resolving on the real one", async () => {
  let handler = null;
  const subscribe = (h) => { handler = h; return () => {}; };

  const promise = awaitHelperCompletion({ isClosed: () => false, subscribe, wait: neverWait });
  handler("junk");
  handler({ type: "mic-permission-result", granted: false, errorName: "NotAllowedError" });

  assert.deepEqual(await promise, { outcome: "denied", errorName: "NotAllowedError" });
});

test("awaitHelperCompletion resolves closed once isClosed() reports true, and unsubscribes", async () => {
  let calls = 0;
  const isClosed = () => { calls += 1; return calls >= 3; };
  let unsubscribed = false;
  const subscribe = () => () => { unsubscribed = true; };

  const result = await awaitHelperCompletion({ isClosed, subscribe, wait: async () => {} });
  assert.deepEqual(result, { outcome: "closed" });
  assert.equal(calls, 3, "must have polled until isClosed() actually reported true");
  assert.equal(unsubscribed, true);
});

test("awaitHelperCompletion never resolves twice, even if a message arrives after closing", async () => {
  let handler = null;
  let resolveCount = 0;
  const subscribe = (h) => { handler = h; return () => {}; };
  // Reports closed on the very first check, then flip handler fires late.
  const promise = awaitHelperCompletion({ isClosed: () => true, subscribe, wait: neverWait });
  promise.then(() => { resolveCount += 1; });

  const first = await promise;
  handler({ type: "mic-permission-result", granted: true, errorName: null }); // arrives too late
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(first, { outcome: "closed" });
  assert.equal(resolveCount, 1, "the promise must settle exactly once");
});

test("awaitHelperCompletion tears down a subscription that resolved synchronously during subscribe()", async () => {
  let unsubscribed = false;
  // Deliberately calls the handler before subscribe() returns, simulating
  // an injected implementation other than the real (always-async)
  // BroadcastChannel-backed one.
  const subscribe = (handler) => {
    handler({ type: "mic-permission-result", granted: true, errorName: null });
    return () => { unsubscribed = true; };
  };

  const result = await awaitHelperCompletion({ isClosed: () => false, subscribe, wait: neverWait });
  assert.deepEqual(result, { outcome: "granted" });
  assert.equal(unsubscribed, true, "the now-stale subscription must still be torn down");
});
