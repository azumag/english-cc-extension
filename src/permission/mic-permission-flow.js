// Pure logic for the mic-permission helper-tab flow (see docs/HANDOFF.md 9.9).
//
// Chrome's Side Panel cannot reliably render the native getUserMedia
// permission prompt: when the extension origin's microphone permission is
// still in the "prompt" (未設定/確認) state, getUserMedia() called directly
// from the side panel rejects immediately with NotAllowedError instead of
// showing the dialog. The fix opens src/permission/mic-permission.html as a
// normal top-level tab (via window.open, not chrome.tabs.create — no "tabs"
// permission needed), where the prompt renders correctly. Granting there
// grants the whole chrome-extension://<id> origin, so a subsequent
// getUserMedia() call from the side panel then succeeds without a prompt.
//
// Every function here is pure / takes its browser API access as an
// argument, so this module is unit-testable without a real browser (see
// tests/mic-permission-flow.test.js). DOM/window/chrome glue lives in
// src/sidepanel/sidepanel.js and src/permission/mic-permission.js instead.

function defaultWait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const MIC_PERMISSION_CHANNEL = "multilingual-cc-mic-permission";

// permissions = the (injected) navigator.permissions object; may be
// undefined in browsers/contexts that don't expose it.
// Returns "granted" | "denied" | "prompt" | "unsupported".
export async function queryMicrophonePermission(permissions) {
  if (!permissions?.query) return "unsupported";
  try {
    const status = await permissions.query({ name: "microphone" });
    if (status?.state === "granted" || status?.state === "denied" || status?.state === "prompt") {
      return status.state;
    }
    return "unsupported";
  } catch {
    // Some browsers/contexts throw (e.g. TypeError) for an unsupported
    // PermissionName. Treat that the same as "we don't know" rather than
    // failing the whole permission flow.
    return "unsupported";
  }
}

// "granted"                        -> try getUserMedia directly, no tab (fast path)
// "prompt"                         -> the side-panel-auto-deny bug case: skip the
//                                      doomed direct attempt and go straight to the
//                                      helper tab, which CAN show the prompt
// "denied"                         -> a helper tab would be auto-denied too (Chrome
//                                      remembers a hard denial per-origin); show
//                                      settings instructions instead of opening one
// "unsupported" / anything else    -> try getUserMedia directly first; only open
//                                      the helper tab if that attempt actually fails
export function decideMicPermissionAction(permissionState) {
  if (permissionState === "prompt") return "open-helper";
  if (permissionState === "denied") return "explain-denied";
  return "request-direct";
}

// Called only after an in-panel getUserMedia attempt has already rejected.
// Opening a helper tab only makes sense for the side-panel-specific
// auto-deny bug (permissionState "prompt" or unknown/"unsupported"). If the
// permission was already reported "granted" and getUserMedia still failed
// with NotAllowedError, that's an OS-level microphone block (e.g. macOS
// System Settings) — a helper tab cannot fix that, so fail closed instead
// of opening a tab that would just fail the same way.
export function shouldOpenHelperAfterFailure({ permissionState, errorName }) {
  if (errorName !== "NotAllowedError") return false;
  return permissionState === "prompt" || permissionState === "unsupported";
}

// Helper-tab side: requests the microphone once and immediately releases
// it, mirroring SpeechRecognizer.requestPermission()'s contract (this
// module intentionally does not depend on SpeechRecognizer to stay free of
// DOM/global coupling).
export async function requestMicrophoneOnce(mediaDevices) {
  if (!mediaDevices?.getUserMedia) return { ok: false, errorName: "MediaDevicesUnavailable" };
  try {
    const stream = await mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return { ok: true };
  } catch (error) {
    return { ok: false, errorName: error?.name ?? "UnknownError" };
  }
}

export function buildHelperResultMessage(result) {
  return {
    type: "mic-permission-result",
    granted: Boolean(result.ok),
    errorName: result.ok ? null : (result.errorName ?? "UnknownError"),
  };
}

// Fail-closed guard for the BroadcastChannel listener on the side-panel
// side: only ever act on messages that actually match our own contract.
export function isMicPermissionResultMessage(data) {
  return Boolean(data) && typeof data === "object" && data.type === "mic-permission-result";
}

const HELPER_ERROR_KEYS = {
  NotAllowedError: "micHelper_errNotAllowed",
  NotFoundError: "micHelper_errNotFound",
  MediaDevicesUnavailable: "micHelper_errMediaUnavailable",
};

// Returns an i18n message key (+ substitutions) rather than a formatted
// string: this module stays chrome-free (see the file header) so it can't
// call chrome.i18n.getMessage() itself. The DOM glue in mic-permission.js
// does the actual t(key, substitutions) call.
export function helperErrorMessage(errorName) {
  const key = HELPER_ERROR_KEYS[errorName];
  if (key) return { key, substitutions: [] };
  return { key: "micHelper_errGeneric", substitutions: [errorName] };
}

// Waits for the helper tab to either report a result or be closed by the
// user without answering. Two independent signals, because neither alone
// is sufficient: closed-polling can't tell "granted then self-closed" from
// "closed without answering" apart, and a message alone misses the tab
// being closed unanswered. Always unsubscribes before resolving.
//
// isClosed(): () => boolean — polls the window.open() WindowProxy's .closed
// subscribe(handler): registers handler(data) for incoming messages, and
//   returns an unsubscribe function
export async function awaitHelperCompletion({ isClosed, subscribe, wait = defaultWait, pollIntervalMs = 500 }) {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = null;

    const finish = (outcome, errorName = null) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      resolve(errorName !== null ? { outcome, errorName } : { outcome });
    };

    const returnedUnsubscribe = subscribe((data) => {
      if (!isMicPermissionResultMessage(data)) return;
      finish(data.granted ? "granted" : "denied", data.granted ? null : (data.errorName ?? "UnknownError"));
    });
    // subscribe() may (in principle, for an injected implementation other
    // than the real BroadcastChannel-based one, which is always async)
    // invoke its handler synchronously before returning. If that already
    // resolved us, the subscription above is stale — tear it down right
    // away instead of assigning it to `unsubscribe` and leaking it.
    if (settled) returnedUnsubscribe();
    else unsubscribe = returnedUnsubscribe;

    (async () => {
      while (!settled) {
        if (isClosed()) {
          finish("closed");
          return;
        }
        await wait(pollIntervalMs);
      }
    })();
  });
}
