/** Only ordinary, empty separators can be flattened in an authorized field.
 * Full namespace/attributes are checked; page/column breaks, bookmarks,
 * hyperlinks, revisions and unknown nodes are never treated as separators. */
import policy from "../shared/field-edit-policy.json" with { type: "json" };
import type { Token } from "./content-guard.ts";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const allowed = new Set(Object.entries(policy.plainSeparators).flatMap(([tag, variants]) => variants.map(attrs =>
  JSON.stringify([`{${W}}${tag}`, Object.entries(attrs).map(([key, value]) => [`{${W}}${key}`, value])]))));
export function isPlainField(sig: Token[]): boolean {
  for (let i = 0; i < sig.length; i++) {
    const token = sig[i];
    if (token[0] === "t") continue;
    if (token[0] !== "s" || !allowed.has(JSON.stringify([token[1], JSON.parse(token[2] || "[]")]))
      || sig[i + 1]?.[0] !== "e" || sig[i + 1]?.[1] !== token[1]) return false;
    i++;
  }
  return true;
}
const whitespace = new Set([...policy.countryWhitespace]);
export const trimCountry = (value: string) => {
  const chars = [...value];
  let start = 0, end = chars.length;
  while (start < end && whitespace.has(chars[start])) start++;
  while (end > start && whitespace.has(chars[end - 1])) end--;
  return chars.slice(start, end).join("");
};
export const normalizeCountryWhitespace = (value: string) => trimCountry([...value].map(ch => whitespace.has(ch) ? " " : ch).join("").replace(/ +/g, " "));
export const splitCountryList = (value: string) => value.split(new RegExp(`[${policy.countryListSeparators}]`, "u")).map(trimCountry).filter(Boolean);
