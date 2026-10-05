/** Document numbering is a context-dependent hierarchy, not a font preset.
 * Mirrors backend/app/numbering.py; all six profiles and limits live in shared/. */
import policy from "../shared/dr-numbering-policy.json" with { type: "json" };
import profiles from "../shared/numbering-profiles.json" with { type: "json" };
export const DR_POLICY = policy;
export type NumberingType = keyof typeof profiles.profiles;
export function numberingProfile(type: NumberingType) { return profiles.profiles[type]; }
function formats(type: NumberingType, language: "zh" | "en") {
  const profile = profiles.profiles[type];
  if ("useResolutionFormats" in profile) return policy.formats[language];
  if ("useAmendmentFormats" in profile) return profiles.amendmentFormats[language];
  return profile.formats[language];
}
export type Marker = { family: string; value: number; length: number };
export type NumberedItem = { text: string; family: string; value: number | null; level: number; key?: string; top?: boolean; reset?: boolean };
export type NumberingPlan = { level: number; reason: string };

function chinese(value: number): string {
  if (value < 10) return policy.chineseDigits[value];
  if (value < 100) return `${value < 20 ? "" : policy.chineseDigits[Math.floor(value / 10)]}十${value % 10 ? policy.chineseDigits[value % 10] : ""}`;
  return "";
}
function chineseValue(text: string): number | null {
  for (let n = 1; n < 100; n++) if (chinese(n) === text) return n;
  return null;
}
function series(value: number, alphabet: string): string {
  if (value <= alphabet.length) return alphabet[value - 1];
  const offset = value - alphabet.length - 1;
  return offset < alphabet.length ** 2 ? alphabet[Math.floor(offset / alphabet.length)] + alphabet[offset % alphabet.length] : "";
}
function seriesValue(text: string, alphabet: string): number | null {
  for (let n = 1; n <= alphabet.length + alphabet.length ** 2; n++) if (series(n, alphabet) === text) return n;
  return null;
}
function roman(value: number): string {
  let result = "";
  for (const [n, token] of [[100,"c"],[90,"xc"],[50,"l"],[40,"xl"],[10,"x"],[9,"ix"],[5,"v"],[4,"iv"],[1,"i"]] as const)
    while (value >= n) { result += token; value -= n; }
  return result;
}
function romanValue(text: string): number | null {
  for (let n = 1; n < 100; n++) if (roman(n) === text.toLowerCase()) return n;
  return null;
}
export function markerOf(text: string, romanContext = false): Marker | null {
  const article = /^\s*第([零一二三四五六七八九十]+)条/.exec(text);
  if (article) { const value = chineseValue(article[1]); return value ? {family:"article",value,length:article[0].length} : null; }
  const match = /^\s*(?:[（(]([^（）()\s]+)[）)]|([0-9]+|[a-zA-Z]+)[.．、)）])/.exec(text);
  if (!match) return null;
  const token = match[1] || match[2], paren = Boolean(match[1]);
  let family = "", value: number | null = null;
  if (/^\d+$/.test(token)) { family = paren ? "paren-decimal" : "decimal"; value = Number(token); }
  else if ((value = chineseValue(token)) !== null) family = "chinese";
  else if ((value = seriesValue(token, policy.zodiac)) !== null) family = "zodiac";
  else if ((value = seriesValue(token, policy.stems)) !== null) family = "stem";
  else if (/^[a-z]$/i.test(token) && !(romanContext && romanValue(token))) { family = "letter"; value = token.toLowerCase().charCodeAt(0) - 96; }
  else if ((value = romanValue(token)) !== null) family = paren ? "roman" : "roman-dot";
  return family && value !== null && value > 0 && value < 100 ? { family, value, length: match[0].length } : null;
}
export function markerText(language: "zh" | "en", level: number, value: number, type: NumberingType = "draft-resolution"): string | null {
  const target = formats(type,language)[level];
  if (!target || value < 1 || value >= 100) return null;
  const token = target.family === "article" || target.family === "chinese" ? chinese(value)
    : target.family === "zodiac" ? series(value, policy.zodiac) : target.family === "stem" ? series(value, policy.stems)
    : target.family === "letter" ? value <= 26 ? String.fromCharCode(96 + value) : "" : target.family.startsWith("roman") ? roman(value) : String(value);
  return token ? target.text.replace("%n", token) : null;
}
/** Keep siblings bound to their series even after descending to a child list.
 * Repeated numeric markers on different ranks cannot be inferred reliably. */
export function planHierarchy(items: NumberedItem[], language: "zh" | "en", type: NumberingType = "draft-resolution"): NumberingPlan[] {
  const ranks = new Map<string, number>(), identities = new Map<string, number>(), ambiguous = new Map<string, string>();
  let parent: number | null = null, active = false;
  return items.map(item => {
    if (item.reset) { ranks.clear(); identities.clear(); ambiguous.clear(); parent=null; active=false; }
    if (item.top) { ranks.clear(); identities.clear(); ambiguous.clear(); active = true; parent = /[：:]$/.test(item.text.trim()) ? 0 : null; return {level:0,reason:""}; }
    if (!item.family) { parent = null; return {level:item.level,reason:""}; }
    const ownRank = formats(type,language).findIndex(target=>target.family===item.family);
    const canonical = ownRank >= 0 ? ownRank : item.family==="roman-dot" && formats(type,language).length===3 ? 2 : policy.defaultLevels[item.family as keyof typeof policy.defaultLevels];
    if (!active) return {level:item.level,reason:"无明确顶层条款，不能确定编号层级"};
    const knownFamily = ranks.has(item.family);
    let level = item.key ? identities.get(item.key) : ranks.get(item.family);
    let reason = "";
    if (level === undefined) {
      level = ranks.get(item.family) ?? canonical ?? item.level;
      if (parent !== null && canonical <= 1) level = parent + 1;
      if (type!=="draft-resolution" && parent!==null && !knownFamily) level=parent+1;
      // Native lists carry a stable identity; context distinguishes their rank
      // even if every list was exported as ilvl=0.
      if (item.key && parent !== null) level = parent + 1;
      if (parent === null && !knownFamily && [...ranks.values()].includes(level)) reason = "不同编号系列占用同一层级，但缺少明确父子关系";
      if (!knownFamily) ranks.set(item.family, level);
      if (item.key) identities.set(item.key, level);
    } else if (parent !== null && parent === level) {
      reason = "相同编号系列既作父项又作子项，层级证据冲突";
    }
    if (level >= formats(type,language).length) reason = "超过该文种配置的编号层次，不能安全转换";
    if (language === "zh" && ["draft-resolution","draft-directive"].includes(type) && item.family === "zodiac" && !knownFamily && ranks.has("stem")) reason = "地支与天干系列交错，疑似编号错字或层级冲突";
    if (reason) ambiguous.set(item.key || item.family,reason);
    reason ||= ambiguous.get(item.key || item.family) || "";
    parent = /[：:]$/.test(item.text.trim()) ? level : null;
    return {level:reason ? item.level : level,reason};
  });
}
/** Independent content guard: ordinal and body must survive. Only an ending
 * already covered by the punctuation policy may differ alongside the marker. */
export function validMarkerChange(before: string, after: string): boolean {
  const tail = (text: string, length: number) => text.slice(length).replace(/[，,；;。.:：、 \t]+$/, "");
  // A lone i/v/x is ambiguous in the source; never use the alternative
  // interpretation to authorize a different Chinese ordinal.
  const old = markerOf(before);
  return Boolean(old && [markerOf(after),markerOf(after,true)].some(next => next && old.value === next.value && tail(before,old.length) === tail(after,next.length)));
}

/** Gaps/repeats are review findings, never permission to renumber. Parent and
 * section boundaries distinguish a legitimate child restart from duplicates. */
export function sequenceIssues(items: NumberedItem[]): {index:number;previous:number}[] {
  const last=new Map<string,number>(), result:{index:number;previous:number}[]=[];
  let previous: NumberedItem | undefined;
  items.forEach((item,index)=>{
    if (item.reset) last.clear();
    if (item.family && item.value!==null) {
      for (const key of last.keys()) if (Number(key.split(":")[0])>item.level) last.delete(key);
      const key=`${item.level}:${item.family}`, old=last.get(key);
      const restart=item.value===1 && previous && (!previous.family && /[：:]$/.test(previous.text.trim()) || previous.level<item.level);
      if (old!==undefined && item.value!==old+1 && !restart) result.push({index,previous:old});
      last.set(key,item.value);
    }
    previous=item;
  });
  return result;
}

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const child = (el: Element, tag: string) => Array.from(el.children).find(n => n.namespaceURI === W && n.localName === tag);
const val = (el: Element | undefined, attr = "val") => el?.getAttributeNS(W, attr) ?? "";
const all = (el: Document | Element, tag: string) => Array.from(el.getElementsByTagNameNS(W, tag));
export type NativeRule = { id: string; ilvl: string; level: number; language: "zh" | "en"; type?: NumberingType };
export function nativeLevel(xml: Document, id: string, ilvl: string): Element | undefined {
  const num = all(xml,"num").find(n=>val(n,"numId")===id);
  if (!num) return undefined;
  const override = all(num,"lvlOverride").find(n=>val(n,"ilvl")===ilvl);
  const own = override && child(override,"lvl");
  if (own) return own;
  const abstract = all(xml,"abstractNum").find(n=>val(n,"abstractNumId")===val(child(num,"abstractNumId")));
  return abstract && all(abstract,"lvl").find(n=>val(n,"ilvl")===ilvl);
}
export function nativeFamily(xml: Document, id: string, ilvl: string): string {
  const lvl = nativeLevel(xml,id,ilvl);
  if (!lvl) return "";
  const text = val(child(lvl,"lvlText"));
  if (text.includes("第%") && text.includes("条")) return "article";
  const family = policy.nativeFamilies[val(child(lvl,"numFmt")) as keyof typeof policy.nativeFamilies] ?? "";
  return family === "decimal" && /^[（(]/.test(text) ? "paren-decimal" : family === "roman" && !/^[（(]/.test(text) ? "roman-dot" : family;
}
/** Word's zodiac/stem formats cycle after 12/10. They cannot represent the
 * handbook's extended 子子/甲甲 series without changing the counter model. */
export function nativeRangeReason(xml: Document, rule: NativeRule, count: number): string {
  const target = formats(rule.type ?? "draft-resolution",rule.language)[rule.level];
  const limit = target?.family === "zodiac" ? policy.zodiac.length : target?.family === "stem" ? policy.stems.length : null;
  if (limit === null) return "";
  const num = all(xml,"num").find(n=>val(n,"numId")===rule.id);
  const override = num && all(num,"lvlOverride").find(n=>val(n,"ilvl")===rule.ilvl);
  const level = nativeLevel(xml,rule.id,rule.ilvl);
  const start = Number(val(override && child(override,"startOverride")) || val(level && child(level,"start")) || "1");
  return !Number.isSafeInteger(start) || start < 1 || start + count - 1 > limit ? "原生编号超过地支/天干单字范围，Word 循环格式不能安全表达学标的扩展编号" : "";
}
/** Only per-instance presentation is changed. A shared abstract, counter,
 * startOverride, restart, membership and reference identity remain intact. */
export function applyNativeRules(xml: Document, rules: NativeRule[]): void {
  for (const rule of rules) {
    const num=all(xml,"num").find(n=>val(n,"numId")===rule.id), original=nativeLevel(xml,rule.id,rule.ilvl);
    const target=formats(rule.type ?? "draft-resolution",rule.language)[rule.level];
    if (!num || !original || !target || !child(original,"numFmt") || !child(original,"lvlText") || !nativeFamily(xml,rule.id,rule.ilvl)) throw new Error("不能证明原生编号的转换规则");
    const placeholder=`%${Number(rule.ilvl)+1}`;
    if (val(child(original,"lvlText")).match(/%[1-9]/g)?.join("") !== placeholder || child(original,"isLgl")) throw new Error("复合编号或法律编号需人工确认");
    const desired=target.text.replace("%n",placeholder);
    if (val(child(original,"numFmt"))===target.fmt && val(child(original,"lvlText"))===desired) continue;
    let override=all(num,"lvlOverride").find(n=>val(n,"ilvl")===rule.ilvl);
    if (!override) { override=xml.createElementNS(W,"w:lvlOverride"); override.setAttributeNS(W,"w:ilvl",rule.ilvl); num.appendChild(override); }
    let level=child(override,"lvl");
    if (!level) { level=original.cloneNode(true) as Element; override.appendChild(level); }
    child(level,"numFmt")!.setAttributeNS(W,"w:val",target.fmt);
    child(level,"lvlText")!.setAttributeNS(W,"w:val",desired);
  }
}
