"use client";

import { useState } from "react";
import type { BrowserDocumentType } from "./docx-browser";
import type { TemplateInput } from "./template-generator";

export default function TemplatePanel({ type, onGenerated }: { type: BrowserDocumentType; onGenerated: (blob: Blob, filename: string) => void }) {
  const [input, setInput] = useState<TemplateInput>({ language: "zh", committee: "", topic: "", country: "", delegate: "", sponsors: "", signatories: "", body: "" });
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function generate() {
    setBusy(true); setError("");
    try {
      const { generateFromTemplate } = await import("./template-generator");
      const result = generateFromTemplate(type, input);
      onGenerated(result.blob, result.filename);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "模板生成失败。"); }
    finally { setBusy(false); }
  }
  const field = (key: keyof TemplateInput, label: string) => <label key={key}>{label}<input value={input[key]} onChange={event => setInput({ ...input, [key]: event.target.value })} /></label>;
  return <details className="studioTool templatePanel"><summary>从规范模板新建文件</summary><p>独立于原稿修复。使用上方所选文种和现有学标规则，不生成或改写正文。每段一行，条款编号请按需要填写。</p><div className="formGrid">
    <label>语言<select value={input.language} onChange={event => setInput({ ...input, language: event.target.value as "zh" | "en" })}><option value="zh">中文</option><option value="en">English</option></select></label>
    {field("committee", "委员会")}{type !== "draft-directive" && field("topic", "议题")}
    {type === "position-paper" ? <>{field("country", "国家 / 席位")}{field("delegate", "代表")}</> : <>{field("sponsors", "起草国（逗号分隔）")}{type !== "working-paper" && field("signatories", "附议国（逗号分隔）")}</>}
    <label className="wide">正文<textarea rows={8} value={input.body} onChange={event => setInput({ ...input, body: event.target.value })} placeholder="填写正文，不会调用 AI 或上传云端" /></label>
  </div>{error && <p role="alert" className="errorBox">{error}</p>}<button className="primaryButton" disabled={busy} onClick={generate}>{busy ? "正在生成…" : "生成规范 DOCX"}</button></details>;
}
