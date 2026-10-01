"use client";

import { useEffect, useRef, useState } from "react";
import { renderPreview } from "./preview-renderer";

export default function DocxPreview({ blob, label }: { blob: Blob; label: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState("正在读取页面…");
  useEffect(() => {
    let active = true;
    const frame = frameRef.current;
    async function render() {
      try {
        setStatus("正在读取页面…");
        if (!frame) return;
        await renderPreview(blob, frame, () => active);
        if (active) setStatus("");
      } catch (error) {
        if (active) setStatus(error instanceof Error ? error.message : "页面预览不可用，仍可下载 DOCX。");
      }
    }
    void render();
    return () => { active = false; };
  }, [blob]);
  return <article className="docxPreview"><h4>{label}</h4>{status && <p role="status">{status}</p>}<iframe ref={frameRef} title={label} sandbox="allow-same-origin" /></article>;
}
