// Thin DOM glue for the mic-permission helper tab (see
// src/permission/mic-permission-flow.js and docs/HANDOFF.md 9.9). This
// script intentionally has no reference to window.opener: the tab must
// keep working standalone even if the side panel that opened it has
// already been closed.
import {
  buildHelperResultMessage,
  helperErrorMessage,
  requestMicrophoneOnce,
  MIC_PERMISSION_CHANNEL,
} from "./mic-permission-flow.js";
import { applyTranslations, createTranslator } from "../i18n/i18n.js";

const t = createTranslator({ getMessage: globalThis.chrome?.i18n?.getMessage?.bind(globalThis.chrome.i18n) });
document.documentElement.lang = globalThis.chrome?.i18n?.getUILanguage?.() ?? document.documentElement.lang;
applyTranslations(document, t);

const statusEl = document.getElementById("permissionStatus");
const retryButton = document.getElementById("retryButton");
const channel = new BroadcastChannel(MIC_PERMISSION_CHANNEL);

async function attempt() {
  retryButton.hidden = true;
  statusEl.textContent = t("micHelper_requesting");

  const result = await requestMicrophoneOnce(navigator.mediaDevices);
  channel.postMessage(buildHelperResultMessage(result));

  if (result.ok) {
    statusEl.textContent = t("micHelper_granted");
    setTimeout(() => window.close(), 1000);
    return;
  }

  const message = helperErrorMessage(result.errorName);
  statusEl.textContent = t(message.key, message.substitutions);
  retryButton.hidden = false;
}

retryButton.addEventListener("click", () => { void attempt(); });

void attempt();
