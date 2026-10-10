"use client";

import { useEffect, useRef, useState } from "react";
import type { BrowserDocumentType } from "./docx-browser";
import type { TemplateInput } from "./template-generator";

export default function TemplatePanel({ type, onGenerated }: { type: BrowserDocumentType; onGenerated: (blob: Blob, filename: string) => void }) {
  const [input, setInput] = useState<TemplateInput>({ language: "zh", committee: "", topic: "", country: "", delegate: "", sponsors: "", signatories: "", body: "" });
  const [pendingType, setPendingType] = useState<BrowserDocumentType | null>(null), [error, setError] = useState("");
  const operation = useRef(0);
  const busy = pendingType === type;
  useEffect(() => () => { operation.current++; setPendingType(null); }, [type]);
  function update(key: keyof TemplateInput, value: string) {
    operation.current++; setPendingType(null); setError("");
    setInput(previous => ({ ...previous, [key]: value }));
  }
  async function generate() {
    const token = ++operation.current;
    setPendingType(type); setError("");
    try {
      const { generateFromTemplate } = await import("./template-generator");
      if (token !== operation.current) return;
      const result = generateFromTemplate(type, input);
      onGenerated(result.blob, result.filename);
    } catch (reason) { if (token === operation.current) setError(reason instanceof Error ? reason.message : "模板生成失败。"); }
    finally { if (token === operation.current) setPendingType(null); }
  }
  const treaty = type === "diplomatic-agreement" || type === "joint-statement";
  const fields: [keyof TemplateInput, string][] = [];
  // Treaties: the parties and subject make the title, and the formatter adds one signature line per party.
  if (treaty) fields.push(["sponsors", "签署方（逗号分隔）"], ["topic", type === "joint-statement" ? "事由（如：海洋塑料污染治理）" : "事由（如：海上搜救合作）"]);
  else {
    fields.push(["committee", "委员会"]);
    if (type !== "draft-directive") fields.push(["topic", "议题"]);
    if (type === "position-paper") fields.push(["country", "国家 / 席位"], ["delegate", "代表"]);
    else {
      fields.push(["sponsors", "起草国（逗号分隔）"]);
      if (type !== "working-paper") fields.push(["signatories", "附议国（逗号分隔）"]);
    }
  }
  return <details className="studioTool templatePanel"><summary>从规范模板新建文件</summary><p>独立于原稿修复。使用上方所选文种和现有学标规则，不生成或改写正文。每段一行，条款编号请按需要填写。</p><div className="formGrid">
    <label>语言<select value={input.language} onChange={event => update("language", event.target.value)}><option value="zh">中文</option><option value="en">English</option></select></label>
    {fields.map(([key, label]) => <label key={key}>{label}<input value={input[key]} onChange={event => update(key, event.target.value)} /></label>)}
    <label className="wide">正文<textarea rows={8} value={input.body} onChange={event => update("body", event.target.value)} placeholder="填写正文，不会调用 AI 或上传云端" /></label>
  </div>{error && <p role="alert" className="errorBox">{error}</p>}<button className="primaryButton" disabled={busy} onClick={generate}>{busy ? "正在生成…" : "生成规范 DOCX"}</button></details>;
}
