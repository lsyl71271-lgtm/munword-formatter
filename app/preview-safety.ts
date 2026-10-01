import { zipSync } from "fflate";
import { readPackage } from "./docx-safety.ts";

/** Apply the engine's ZIP budget before JSZip; strip external preview targets.
 * This copy is only for display. The downloadable original/output is untouched.
 */
export function preparePreview(content: ArrayBuffer): ArrayBuffer {
  const parts = readPackage(content);
  if (parts["word/document.xml"].length > 2 * 1024 * 1024) throw new Error("文档较大，已跳过页面预览；仍可正常排版和下载。");
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  for (const [name, bytes] of Object.entries(parts)) {
    if (!name.endsWith(".rels")) continue;
    const xml = new DOMParser().parseFromString(decoder.decode(bytes), "application/xml");
    if (xml.getElementsByTagName("parsererror").length) throw new Error("预览关系部件损坏。");
    for (const relation of Array.from(xml.getElementsByTagNameNS("*", "Relationship"))) {
      const target = relation.getAttribute("Target") || "";
      if (relation.getAttribute("TargetMode")?.toLowerCase() === "external" || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(target)) relation.remove();
    }
    parts[name] = encoder.encode(new XMLSerializer().serializeToString(xml));
  }
  return zipSync(parts).slice().buffer as ArrayBuffer;
}
