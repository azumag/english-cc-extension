// Thin DOM glue for the mic-permission helper tab (see
// src/permission/mic-permission-flow.js and docs/HANDOFF.md 9.9). This
// script intentionally has no reference to window.opener: the tab must
// keep working standalone even if the side panel that opened it has
// already been closed.
import {
  buildHelperResultMessage,
  helperErrorLabel,
  requestMicrophoneOnce,
  MIC_PERMISSION_CHANNEL,
} from "./mic-permission-flow.js";

const statusEl = document.getElementById("permissionStatus");
const retryButton = document.getElementById("retryButton");
const channel = new BroadcastChannel(MIC_PERMISSION_CHANNEL);

async function attempt() {
  retryButton.hidden = true;
  statusEl.textContent = "マイクの許可を要求しています。表示されるダイアログで「許可」を選んでください。";

  const result = await requestMicrophoneOnce(navigator.mediaDevices);
  channel.postMessage(buildHelperResultMessage(result));

  if (result.ok) {
    statusEl.textContent = "マイクを許可しました。このタブは自動的に閉じます。";
    setTimeout(() => window.close(), 1000);
    return;
  }

  statusEl.textContent = helperErrorLabel(result.errorName);
  retryButton.hidden = false;
}

retryButton.addEventListener("click", () => { void attempt(); });

void attempt();
