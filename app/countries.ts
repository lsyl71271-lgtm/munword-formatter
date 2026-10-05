/** Whole-name identity/display/sorting; mirrors backend/app/countries.py.
 * All names and exceptions come from ONE table: shared/country-names.json.
 * No substring matching, suffix inference or body replacement.
 */
import data from "../shared/country-names.json" with { type: "json" };
import pinyin from "../shared/country-pinyin.json" with { type: "json" };
import policy from "../shared/document-policy.json" with { type: "json" };

export type CountryLanguage = "zh" | "en";
export type CountryStatus = "resolved" | "ambiguous" | "historical" | "entity" | "unknown";
export type CountryResolution = { input: string; display: string; id: string | null; status: CountryStatus; sortName: string; changed: boolean };
export const COUNTRY_DATA_DATE = data.checked_on;
const nameKey = (value: string) => value.normalize("NFKC").replace(/[’‘]/g, "'").replace(/\s+/gu, " ").trim().toLowerCase();
const index = new Map<string, typeof data.records>();
for (const record of data.records) for (const name of [...Object.values(record.formal), ...Object.values(record.source_formal), ...Object.values(record.short), ...record.aliases]) {
  const key = nameKey(name), existing = index.get(key) || [];
  if (!existing.some(item => item.id === record.id)) index.set(key, [...existing, record]);
}
const review = new Map<string, CountryStatus>();
for (const [category, names] of [["ambiguous", data.policy.ambiguous], ["historical", data.policy.historical], ["entity", data.policy.organizations]] as const) {
  for (const name of names) review.set(nameKey(name), category);
}

export function resolveCountry(input: string, language: CountryLanguage): CountryResolution {
  const key = nameKey(input), matches = index.get(key) || [];
  const status = review.get(key) || (matches.length > 1 ? "ambiguous" : matches.length === 0 ? "unknown" : matches[0].kind === "member-state" ? "resolved" : "entity");
  const record = status === "resolved" ? matches[0] : null;
  // Supplied full forms, including UNTERM's grammatical English article,
  // stay unchanged. Aliases use the full field form without that article.
  const alreadyFormal = record && [record.formal[language], record.source_formal[language]].includes(input);
  const display = record ? alreadyFormal ? input : record.formal[language] : input;
  return { input, display, id: record?.id ?? null, status, sortName: record?.sort_name[language] ?? input, changed: display !== input };
}

const phrases = new Map(Object.entries(pinyin.phrases).map(([name, reading]) => [name, reading.split(" ")]));
const longest = Math.max(...[...phrases.keys()].map(name => [...name].length));
export function countrySortKey(value: string, language: CountryLanguage): string[] {
  if (language !== "zh") return [value.toLowerCase()];
  const chars = [...value], key: string[] = [];
  for (let i = 0; i < chars.length;) {
    let length = Math.min(longest, chars.length - i);
    while (length && !phrases.has(chars.slice(i, i + length).join(""))) length--;
    if (length) { key.push(...phrases.get(chars.slice(i, i + length).join(""))!); i += length; }
    else { key.push((pinyin.chars as Record<string, string>)[chars[i]] ?? chars[i].toLowerCase()); i++; }
  }
  return key;
}
// Python orders Unicode code points, not JavaScript UTF-16 code units.
const compareText = (a: string, b: string) => {
  const left = [...a], right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (difference) return difference;
  }
  return left.length - right.length;
};
const compare = (a: string[], b: string[]) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return compareText(a[i], b[i]);
  return a.length - b.length;
};

export function planCountries(values: string[], language: CountryLanguage, preserveOrder = false) {
  const resolutions = values.filter(value => value.trim()).map(value => resolveCountry(value, language));
  const seen = new Set<string>();
  const kept = resolutions.filter(item => {
    if (!item.id) return true; // Unconfirmed entities must not silently vanish.
    if (seen.has(item.id)) return false;
    seen.add(item.id); return true;
  });
  if (!preserveOrder) {
    const keys = new Map(kept.map(item => [item, countrySortKey(item.sortName, language)]));
    kept.sort((a, b) => compare(keys.get(a)!, keys.get(b)!));
  }
  return { values: kept.map(item => item.display), resolutions, removedDuplicates: resolutions.length - kept.length };
}

export function countryWarnings(values: string[], language: CountryLanguage): string[] {
  const reasons = { ambiguous: "称呼有歧义", historical: "历史国家或历史名称", entity: "组织、观察员或其他非会员国实体", unknown: "资料表未确认的名称" };
  return [...new Set(values.filter(value => value.trim()).map(value => resolveCountry(value, language)).filter(item => item.status !== "resolved")
    .map(item => `“${item.input}”属于${reasons[item.status as keyof typeof reasons]}；已保留原输入，请在第 03 步人工确认。`))];
}

export function splitCountryNames(value: string): string[] {
  if (!value.trim()) return [];
  if (index.has(nameKey(value)) || review.has(nameKey(value))) return [value.trim()];
  return value.split(/[,，、;；/|\n]+/u).map(item => item.trim()).filter(Boolean);
}

/** Parse ONLY known country-field labels, not arbitrary text before a colon. */
export function countryFieldValue(text: string): string | null {
  const match = text.match(/^\s*([^:：]+)[:：]\s*([\s\S]*)$/u);
  if (!match) return text.trim().replace(/^[:：\s]+/u, "");
  return policy.metadata.country.aliases.some(label => nameKey(label).replace(/ /g, "") === nameKey(match[1]).replace(/ /g, "")) ? match[2].trim() : null;
}

/** Independent guard: source identity AND formal output must agree. */
export function validCountryFieldChange(before: string, after: string, language: CountryLanguage): boolean {
  const source = countryFieldValue(before), target = countryFieldValue(after);
  if (source === null || target === null) return false;
  const resolved = resolveCountry(source, language);
  return resolved.status === "resolved" && resolved.display === target;
}
