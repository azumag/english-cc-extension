import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildObsWebSocketUrl, createObsAuthentication } from "../src/obs/obs-websocket-client.js";

function independentAuthentication(password, salt, challenge) {
  const secret = createHash("sha256").update(`${password}${salt}`).digest("base64");
  return createHash("sha256").update(`${secret}${challenge}`).digest("base64");
}

test("creates the obs-websocket challenge response", async () => {
  const password = "supersecretpassword";
  const salt = "lM1GncleQOaCu9dL1yeUZhFYnqhsLLP1G5lAGo3ixaI=";
  const challenge = "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=";
  const result = await createObsAuthentication(password, salt, challenge);
  assert.equal(result, independentAuthentication(password, salt, challenge));
});

test("only permits loopback OBS hosts", () => {
  assert.equal(buildObsWebSocketUrl({ host: "127.0.0.1", port: 4455 }), "ws://127.0.0.1:4455");
  assert.throws(() => buildObsWebSocketUrl({ host: "example.com", port: 4455 }), /must be/);
});
