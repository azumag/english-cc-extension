// Single source of truth for the language picker: pairs each Chrome
// Translator API tag with the BCP 47 recognition locale(s) that feed it and
// each language's own endonym (its name in itself — "日本語", "English",
// "中文（繁體）"). Endonyms stay outside the i18n message catalog on purpose:
// a language's name in itself doesn't change when the UI's display language
// does (see docs/HANDOFF.md).
//
// Pure module — no chrome.* / DOM access — so it's unit-testable with
// node:test (see tests/language-catalog.test.js). DOM glue lives in
// src/sidepanel/sidepanel.js.
import { toTranslatorLanguageTag } from "./language-tags.js";

const LANGUAGES = [
  { translatorTag: "ja", nativeName: "日本語", recognitionLocales: [{ locale: "ja-JP", nativeName: "日本語" }] },
  {
    translatorTag: "en",
    nativeName: "English",
    recognitionLocales: [
      { locale: "en-US", nativeName: "English (US)" },
      { locale: "en-GB", nativeName: "English (UK)" },
    ],
  },
  { translatorTag: "zh", nativeName: "中文（简体）", recognitionLocales: [{ locale: "zh-CN", nativeName: "中文（简体）" }] },
  { translatorTag: "zh-Hant", nativeName: "中文（繁體）", recognitionLocales: [{ locale: "zh-TW", nativeName: "中文（繁體）" }] },
  { translatorTag: "ko", nativeName: "한국어", recognitionLocales: [{ locale: "ko-KR", nativeName: "한국어" }] },
  { translatorTag: "es", nativeName: "Español", recognitionLocales: [{ locale: "es-ES", nativeName: "Español" }] },
  { translatorTag: "fr", nativeName: "Français", recognitionLocales: [{ locale: "fr-FR", nativeName: "Français" }] },
  { translatorTag: "de", nativeName: "Deutsch", recognitionLocales: [{ locale: "de-DE", nativeName: "Deutsch" }] },
  { translatorTag: "pt", nativeName: "Português", recognitionLocales: [{ locale: "pt-BR", nativeName: "Português" }] },
  { translatorTag: "it", nativeName: "Italiano", recognitionLocales: [{ locale: "it-IT", nativeName: "Italiano" }] },
  { translatorTag: "ru", nativeName: "Русский", recognitionLocales: [{ locale: "ru-RU", nativeName: "Русский" }] },
  { translatorTag: "uk", nativeName: "Українська", recognitionLocales: [{ locale: "uk-UA", nativeName: "Українська" }] },
];

// select() value that means "use the adjacent free-text input instead".
export const CUSTOM_LANGUAGE_VALUE = "__custom__";

export function recognitionLanguageOptions() {
  return LANGUAGES.flatMap((lang) =>
    lang.recognitionLocales.map((rl) => ({ value: rl.locale, label: rl.nativeName })));
}

export function targetLanguageOptions() {
  return LANGUAGES.map((lang) => ({ value: lang.translatorTag, label: lang.nativeName }));
}

// Resolves a stored setting value (which may predate the catalog, or simply
// not be in it — Chrome may support more languages than we list) against a
// select's option list. A case-insensitive match selects that option;
// anything else falls back to the "custom" option with the stored value
// preserved verbatim in customValue, so no saved setting is ever silently
// dropped or replaced.
export function resolveSelectValue(storedValue, options) {
  const value = String(storedValue ?? "").trim();
  if (!value) return { selectValue: CUSTOM_LANGUAGE_VALUE, customValue: "" };
  const match = options.find((option) => option.value.toLowerCase() === value.toLowerCase());
  if (match) return { selectValue: match.value, customValue: "" };
  return { selectValue: CUSTOM_LANGUAGE_VALUE, customValue: value };
}

// Inverse of resolveSelectValue: reads back whichever of the select/custom
// input pair currently holds the effective value.
export function readLanguageControl({ selectValue, customValue }) {
  if (selectValue === CUSTOM_LANGUAGE_VALUE) return String(customValue ?? "").trim();
  return selectValue;
}

const RECOGNITION_LOCALE_BY_TRANSLATOR_TAG = new Map(
  LANGUAGES.map((lang) => [lang.translatorTag, lang.recognitionLocales[0].locale]));

// Best-effort swap of the recognition/target language pair. The two sides
// use different tag systems (BCP 47 locale vs. Translator API tag) that
// aren't always symmetric — e.g. the Translator tag "en" could come back as
// either en-US or en-GB — so this is intentionally lossy rather than
// exact: recognitionLanguage -> targetLanguage always follows the existing
// toTranslatorLanguageTag() normalization; targetLanguage -> recognitionLanguage
// prefers this catalog's first recognition locale for that tag, and falls
// back to using the tag itself as the locale when it isn't in the catalog
// (Web Speech API accepts bare language tags; an unsupported one fails
// closed via the existing "language-not-supported" fatal error).
export function swapLanguagePair({ recognitionLanguage, targetLanguage }) {
  const newTargetLanguage = toTranslatorLanguageTag(recognitionLanguage);
  const targetTag = toTranslatorLanguageTag(targetLanguage);
  const newRecognitionLanguage = RECOGNITION_LOCALE_BY_TRANSLATOR_TAG.get(targetTag) ?? targetLanguage;
  return { recognitionLanguage: newRecognitionLanguage, targetLanguage: newTargetLanguage };
}

// Maps a Translator.availability() result (plus the "same-language" short
// circuit sidepanel.js applies before calling it) to the i18n message key
// used to render it.
const PAIR_AVAILABILITY_KEYS = {
  "same-language": "pair_sameLanguage",
  available: "pair_available",
  downloadable: "pair_downloadable",
  downloading: "pair_downloading",
  unavailable: "pair_unavailable",
};

export function pairAvailabilityMessageKey(state) {
  return PAIR_AVAILABILITY_KEYS[state] ?? "pair_unknown";
}
