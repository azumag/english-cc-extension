const TRADITIONAL_CHINESE_SUBTAGS = new Set(["hant", "tw", "hk", "mo"]);

export function toTranslatorLanguageTag(value) {
  const normalized = String(value ?? "").trim().replace(/_/g, "-");
  if (!normalized) return "";
  const subtags = normalized.split("-").filter(Boolean);
  const base = subtags[0]?.toLowerCase() ?? "";
  if (base !== "zh") return base;
  const traditional = subtags.slice(1).some((subtag) => TRADITIONAL_CHINESE_SUBTAGS.has(subtag.toLowerCase()));
  return traditional ? "zh-Hant" : "zh";
}

export function targetAllowsCjkText(value) {
  const tag = toTranslatorLanguageTag(value);
  return tag === "ja" || tag === "zh" || tag === "zh-Hant";
}
