import test from "node:test";
import assert from "node:assert/strict";
import { ObsCaptionOutput } from "../src/obs/obs-caption-output.js";

function fakeClient(responses) {
  const calls = [];
  return {
    connected: true,
    calls,
    async request(type, data = {}) {
      calls.push([type, data]);
      const response = responses[type];
      return typeof response === "function" ? response(data) : response;
    },
  };
}

test("sends a caption only while streaming and unmuted", async () => {
  const client = fakeClient({
    GetVersion: { availableRequests: ["SendStreamCaption"] },
    GetStreamStatus: { outputActive: true },
    GetInputMute: { inputMuted: false },
    SendStreamCaption: {},
  });
  const output = new ObsCaptionOutput({ client, microphoneInputName: "Mic/Aux" });
  const result = await output.sendCaption("Hello world");
  assert.deepEqual(result, { sent: true });
  assert.equal(client.calls.at(-1)[0], "SendStreamCaption");
});

test("does not send while OBS is offline", async () => {
  const client = fakeClient({
    GetVersion: { availableRequests: ["SendStreamCaption"] },
    GetStreamStatus: { outputActive: false },
  });
  const output = new ObsCaptionOutput({ client });
  assert.deepEqual(await output.sendCaption("Hello"), { sent: false, reason: "obs-not-streaming" });
  assert.equal(client.calls.some(([type]) => type === "SendStreamCaption"), false);
});

test("does not send while the configured microphone is muted", async () => {
  const client = fakeClient({
    GetVersion: { availableRequests: ["SendStreamCaption"] },
    GetStreamStatus: { outputActive: true },
    GetInputMute: { inputMuted: true },
  });
  const output = new ObsCaptionOutput({ client, microphoneInputName: "Mic/Aux" });
  assert.deepEqual(await output.sendCaption("Hello"), { sent: false, reason: "microphone-muted" });
});
