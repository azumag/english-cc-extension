const JAPANESE_TEXT = /[\u3040-\u30ff\u3400-\u9fff々〆ヵヶ]/u;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const PUNCTUATION_REPLACEMENTS = Object.freeze({
  "\u2018": "'",
  "\u2019": "'",
  "\u201c": "\"",
  "\u201d": "\"",
  "\u2013": "-",
  "\u2014": "-",
  "\u2026": "...",
  "\u00a0": " ",
});

export function normalizeCaptionText(value) {
  let text = String(value ?? "").normalize("NFKC");
  for (const [from, to] of Object.entries(PUNCTUATION_REPLACEMENTS)) {
    text = text.split(from).join(to);
  }
  return text
    .replace(CONTROL_CHARACTERS, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function containsJapaneseText(value) {
  return JAPANESE_TEXT.test(String(value ?? ""));
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyCaptionReplacements(value, replacements = {}) {
  const text = String(value ?? "");
  const entries = Object.entries(replacements)
    .filter(([from]) => from)
    .sort(([a], [b]) => b.length - a.length);
  if (!entries.length) return text;

  const replacementMap = new Map(entries.map(([from, to]) => [from, String(to)]));
  const pattern = new RegExp(entries.map(([from]) => escapeRegularExpression(from)).join("|"), "g");
  return text.replace(pattern, (matched) => replacementMap.get(matched) ?? matched);
}

function splitOversizedWord(word, maxChars) {
  const chunks = [];
  for (let start = 0; start < word.length; start += maxChars) {
    chunks.push(word.slice(start, start + maxChars));
  }
  return chunks;
}

export function segmentCaptionText(value, maxChars = 72) {
  const text = normalizeCaptionText(value);
  if (!text) return [];
  if (!Number.isInteger(maxChars) || maxChars < 1 || text.length <= maxChars) return [text];

  const words = text.split(" ").flatMap((word) => (
    word.length > maxChars ? splitOversizedWord(word, maxChars) : [word]
  ));
  const segments = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) segments.push(current);
    current = word;
  }
  if (current) segments.push(current);
  return segments;
}

export class CaptionPolicy {
  constructor({ maxAgeMs = 5000, maxCaptionChars = 72, replacements = {}, clock = () => Date.now() } = {}) {
    this.maxAgeMs = maxAgeMs;
    this.maxCaptionChars = maxCaptionChars;
    this.replacements = replacements;
    this.clock = clock;
    this.lastSentText = "";
  }

  prepare({ text, createdAt = this.clock() } = {}) {
    if (this.clock() - createdAt > this.maxAgeMs) {
      return { ok: false, reason: "expired", segments: [] };
    }

    const normalized = normalizeCaptionText(applyCaptionReplacements(text, this.replacements));
    if (!normalized) return { ok: false, reason: "empty", segments: [] };
    if (containsJapaneseText(normalized)) return { ok: false, reason: "contains-japanese", segments: [] };
    if (normalized === this.lastSentText) return { ok: false, reason: "duplicate", segments: [] };

    const segments = segmentCaptionText(normalized, this.maxCaptionChars);
    if (!segments.length) return { ok: false, reason: "empty", segments: [] };
    return { ok: true, canonicalText: normalized, segments };
  }

  markSent(canonicalText) {
    this.lastSentText = normalizeCaptionText(canonicalText);
  }

  reset() {
    this.lastSentText = "";
  }
}
