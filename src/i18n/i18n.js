// Thin wrapper around chrome.i18n.getMessage so the rest of the codebase
// (and its tests) never call chrome.* directly — the same "pure module +
// thin DOM/chrome glue" split used elsewhere (see
// src/permission/mic-permission-flow.js). The UI's display language always
// follows Chrome's own UI language (chrome.i18n has no runtime locale
// switch); see docs/HANDOFF.md for the reasoning and the extension point
// this indirection leaves for a future manual switcher.

// getMessage: (key: string, substitutions?: string[]) => string — normally
// chrome.i18n.getMessage.bind(chrome.i18n). Injectable so callers/tests
// don't need a real chrome global.
export function createTranslator({ getMessage } = {}) {
  const resolve = typeof getMessage === "function" ? getMessage : () => "";
  return function t(key, substitutions) {
    const message = resolve(key, substitutions);
    // chrome.i18n.getMessage returns "" for an unknown key. Falling back to
    // the key itself keeps a missing translation visible/greppable instead
    // of rendering a blank label.
    return message || key;
  };
}

// Walks root for data-i18n / data-i18n-placeholder / data-i18n-title /
// data-i18n-aria-label attributes and fills in the corresponding
// text/attribute via t(). Pure DOM glue, not unit-tested directly — see
// tests/i18n-messages.test.js for the key-coverage checks that stand in for
// it (every attribute value here must resolve in both locale catalogs).
export function applyTranslations(root, t) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.getAttribute("data-i18n"));
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
  }
  for (const el of root.querySelectorAll("[data-i18n-aria-label]")) {
    el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria-label")));
  }
}
