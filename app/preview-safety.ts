import { zipSync } from "fflate";
import { decodeXml, readPackage } from "./docx-safety.ts";

const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** The part a relationships file belongs to ("word/_rels/document.xml.rels" → "word/document.xml"). */
const ownerOf = (rels: string) => rels.replace(/(^|\/)_rels\/([^/]+)\.rels$/, "$1$2");

/** The package path a relationship target points to, seen from its owner part. */
function resolveTarget(owner: string, target: string): string {
  const segments = target.startsWith("/") ? [] : owner.split("/").slice(0, -1);
  for (const segment of target.replace(/^\/+/, "").split("/")) {
    if (segment === "..") segments.pop(); else if (segment && segment !== ".") segments.push(segment);
  }
  return segments.join("/");
}

const PICTURES = ["blip", "imagedata", "fill"];

/** Apply the engine's ZIP budget before JSZip; strip external preview targets.
 * This copy is only for display. The downloadable original/output is untouched.
 *
 * docx-preview builds its elements in the page's own document before they are
 * moved into the sandboxed frame, so the frame's CSP does not cover that phase:
 * a picture whose source cannot be found becomes <img src="null"> and is
 * requested from the hosting origin.  Every picture whose relationship was
 * stripped, is missing, or points at a part the package does not hold is
 * therefore dropped from the preview copy.
 */
export function preparePreview(content: ArrayBuffer): ArrayBuffer {
  const parts = readPackage(content);
  if (parts["word/document.xml"].length > 2 * 1024 * 1024) throw new Error("文档较大，已跳过页面预览；仍可正常排版和下载。");
  const decoder = { decode: decodeXml }, encoder = new TextEncoder();
  const stripped = new Map<string, Set<string>>(), resolvable = new Map<string, Set<string>>();
  for (const [name, bytes] of Object.entries(parts)) {
    if (!/\.rels$/i.test(name)) continue;
    const xml = new DOMParser().parseFromString(decoder.decode(bytes), "application/xml");
    if (xml.getElementsByTagName("parsererror").length) throw new Error("预览关系部件损坏。");
    const removed = new Set<string>(), found = new Set<string>(), owner = ownerOf(name);
    for (const relation of Array.from(xml.getElementsByTagNameNS("*", "Relationship"))) {
      const target = relation.getAttribute("Target") || "";
      if (relation.getAttribute("TargetMode")?.toLowerCase() === "external" || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(target)) {
        removed.add(relation.getAttribute("Id") || "");
        relation.remove();
      } else if (parts[resolveTarget(owner, target.trim())]) found.add(relation.getAttribute("Id") || "");
    }
    parts[name] = encoder.encode(new XMLSerializer().serializeToString(xml));
    if (removed.size) stripped.set(owner, removed);
    resolvable.set(owner, found);
  }
  for (const owner of Object.keys(parts)) {
    if (!/^word\/.+\.xml$/i.test(owner)) continue;
    const removed = stripped.get(owner) ?? new Set<string>(), found = resolvable.get(owner) ?? new Set<string>();
    const text = decoder.decode(parts[owner]);
    if (!removed.size && !/<[\w]*:?(?:blip|imagedata|fill)\b/.test(text)) continue;
    const xml = new DOMParser().parseFromString(text, "application/xml");
    if (xml.getElementsByTagName("parsererror").length) throw new Error("预览部件损坏。");
    let changed = false;
    for (const element of Array.from(xml.getElementsByTagNameNS("*", "*"))) {
      if (!element.parentNode) continue;
      const references = ["embed", "link", "id"].map(name => element.getAttributeNS(R_NS, name)).filter(Boolean) as string[];
      if (PICTURES.includes(element.localName) && references.some(id => !found.has(id))) {
        // The picture, not just the reference: a picture without a source is still requested.
        let picture: Element = element;
        for (let node: Element | null = element; node; node = node.parentElement) {
          if (["drawing", "pict", "object"].includes(node.localName)) { picture = node; break; }
        }
        picture.remove();
        changed = true;
      } else if (references.some(id => removed.has(id))) {
        for (const name of ["embed", "link", "id"]) if (removed.has(element.getAttributeNS(R_NS, name) || "")) element.removeAttributeNS(R_NS, name);
        changed = true;
      }
    }
    if (changed) parts[owner] = encoder.encode(new XMLSerializer().serializeToString(xml));
  }
  return zipSync(parts).slice().buffer as ArrayBuffer;
}
