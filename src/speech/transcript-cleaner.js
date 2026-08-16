import { applyCaptionReplacements, normalizeCaptionText } from "../captions/caption-policy.js";

// Cleans a recognition transcript before it reaches translation: NFKC
// normalization (half-width katakana, punctuation variants), control/blank
// cleanup, plus the user's exact-match replacements so words Chrome keeps
// mishearing (channel-specific names, game terms, filler) can be corrected
// at the source instead of only patching the translated output.
export function cleanTranscript(value, replacements = {}) {
  return normalizeCaptionText(applyCaptionReplacements(String(value ?? ""), replacements));
}
