import { preparePreview } from "./preview-safety.ts";

/** Shared by React and the offline HTML UI; no external fetches or scripts. */
export async function renderPreview(blob: Blob, frame: HTMLIFrameElement, isCurrent = () => true) {
  const content = preparePreview(await blob.arrayBuffer());
  const { renderAsync } = await import("docx-preview");
  if (!isCurrent() || !frame.contentDocument) return;
  const doc = frame.contentDocument;
  doc.open();
  doc.write('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:; connect-src \'none\'; base-uri \'none\'; form-action \'none\'"><style>body{margin:0;background:#edf1f5}section.docx{margin:16px auto!important;max-width:100%;box-sizing:border-box} .docx-wrapper{padding:12px!important}</style></head><body></body></html>');
  doc.close();
  doc.addEventListener("click", event => event.preventDefault(), true);
  const body = doc.createElement("div"), styles = doc.createElement("div");
  await renderAsync(content, body, styles, {
    useBase64URL: true, renderAltChunks: false, renderComments: false,
    renderChanges: true, ignoreLastRenderedPageBreak: false,
    renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
  });
  // A slower prior render must not replace a newer file's preview.
  if (!isCurrent() || frame.contentDocument !== doc) return;
  doc.body.replaceChildren(...Array.from(body.childNodes));
  for (const style of Array.from(styles.childNodes)) doc.head.appendChild(style);
}
