import { zipSync } from "fflate";
import { readPackage } from "./docx-safety.ts";

const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** The part a relationships file belongs to ("word/_rels/document.xml.rels" → "word/document.xml"). */
const ownerOf = (rels: string) => rels.replace(/(^|\/)_rels\/([^/]+)\.rels$/, "$1$2");

/** Apply the engine's ZIP budget before JSZip; strip external preview targets.
 * This copy is only for display. The downloadable original/output is untouched.
 *
 * docx-preview builds its elements in the page's own document before they are
 * moved into the sandboxed frame, so the frame's CSP does not cover that phase:
 * a picture whose relationship was stripped became <img src="null"> and was
 * requested from the hosting origin.  Pictures pointing at a stripped
 * relationship are therefore dropped from the preview copy as well.
 */
export function preparePreview(content: ArrayBuffer): ArrayBuffer {
  const parts = readPackage(content);
  if (parts["word/document.xml"].length > 2 * 1024 * 1024) throw new Error("文档较大，已跳过页面预览；仍可正常排版和下载。");
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  const stripped = new Map<string, Set<string>>();
  for (const [name, bytes] of Object.entries(parts)) {
    if (!name.endsWith(".rels")) continue;
    const xml = new DOMParser().parseFromString(decoder.decode(bytes), "application/xml");
    if (xml.getElementsByTagName("parsererror").length) throw new Error("预览关系部件损坏。");
    const removed = new Set<string>();
    for (const relation of Array.from(xml.getElementsByTagNameNS("*", "Relationship"))) {
      const target = relation.getAttribute("Target") || "";
      if (relation.getAttribute("TargetMode")?.toLowerCase() === "external" || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(target)) {
        removed.add(relation.getAttribute("Id") || "");
        relation.remove();
      }
    }
    parts[name] = encoder.encode(new XMLSerializer().serializeToString(xml));
    if (removed.size) stripped.set(ownerOf(name), removed);
  }
  for (const [owner, removed] of stripped) {
    if (!parts[owner] || !owner.endsWith(".xml")) continue;
    const xml = new DOMParser().parseFromString(decoder.decode(parts[owner]), "application/xml");
    if (xml.getElementsByTagName("parsererror").length) throw new Error("预览部件损坏。");
    let changed = false;
    for (const element of Array.from(xml.getElementsByTagNameNS("*", "*"))) {
      const references = ["embed", "link", "id"].map(name => element.getAttributeNS(R_NS, name)).filter(Boolean) as string[];
      if (!references.some(id => removed.has(id))) continue;
      if (["blip", "imagedata", "fill"].includes(element.localName)) {
        // The picture, not just the reference: a picture without a source is still requested.
        let picture: Element = element;
        for (let node: Element | null = element; node; node = node.parentElement) {
          if (["drawing", "pict", "object"].includes(node.localName)) { picture = node; break; }
        }
        picture.remove();
      } else {
        for (const name of ["embed", "link", "id"]) if (removed.has(element.getAttributeNS(R_NS, name) || "")) element.removeAttributeNS(R_NS, name);
      }
      changed = true;
    }
    if (changed) parts[owner] = encoder.encode(new XMLSerializer().serializeToString(xml));
  }
  return zipSync(parts).slice().buffer as ArrayBuffer;
}
