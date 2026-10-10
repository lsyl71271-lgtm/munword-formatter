"use client";

import { DragEvent, useMemo, useRef, useState } from "react";
import { formatDocxInBrowser, isTreaty, parseDocxInBrowser } from "./docx-browser";
import type { BrowserDocumentType as DocumentType, BrowserModel as Model, BrowserValidation as Validation } from "./docx-browser";
import DocxPreview from "./docx-preview";
import TemplatePanel from "./template-panel";
import { buildDiagnosticReport } from "./diagnostics";
import { COUNTRY_DATA_DATE, countryWarnings, planCountries, splitCountryNames } from "./countries";
import release from "../package.json";
import { MAX_UPLOAD } from "./docx-safety";

const DOCUMENT_TYPES: Array<{ id: DocumentType; zh: string; en: string; badge: string }> = [
  { id: "position-paper", zh: "立场文件", en: "Position Paper", badge: "PP" },
  { id: "working-paper", zh: "工作文件", en: "Working Paper", badge: "WP" },
  { id: "draft-directive", zh: "指令草案", en: "Draft Directive", badge: "DD" },
  { id: "draft-resolution", zh: "决议草案", en: "Draft Resolution", badge: "DR" },
  { id: "friendly-amendment", zh: "友好修正案", en: "Friendly Amendment", badge: "FA" },
  { id: "unfriendly-amendment", zh: "非友好修正案", en: "Unfriendly Amendment", badge: "UA" },
  { id: "diplomatic-agreement", zh: "外交协定", en: "Diplomatic Agreement", badge: "DA" },
  { id: "joint-statement", zh: "联合声明", en: "Joint Statement", badge: "JS" },
];

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";
const REQUEST_TIMEOUT_MS = 120_000;

function splitCountryInput(value: string) {
  return splitCountryNames(value);
}

function decodeHeader(value: string | null) {
  if (!value) return [];
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return [];
  }
}

function getDownloadName(disposition: string | null) {
  const match = disposition?.match(/filename\*=UTF-8''([^;]+)/i);
  try { return match ? decodeURIComponent(match[1]) : "PKUNMUN2026_格式化文件.docx"; }
  catch { return "PKUNMUN2026_格式化文件.docx"; }
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function readError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { detail?: string | { message?: string } | Array<{ msg?: string }> };
    if (body?.detail && typeof body.detail === "object" && "message" in body.detail && body.detail.message?.trim()) return body.detail.message;
    if (typeof body?.detail === "string" && body.detail.trim()) return body.detail;
    if (Array.isArray(body?.detail)) {
      const messages = body.detail.map((item: { msg?: string }) => item?.msg).filter(Boolean);
      if (messages.length) return messages.join("；");
    }
  } catch {
    // The server may return plain text or an empty response.
  }
  return fallback;
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const operationRef = useRef(0);
  const [documentType, setDocumentType] = useState<DocumentType>("draft-resolution");
  const [file, setFile] = useState<File | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  const [validations, setValidations] = useState<Validation[]>([]);
  const [stage, setStage] = useState<"upload" | "review" | "done">("upload");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [preserveOrder, setPreserveOrder] = useState(false);
  const [normalizePunctuation, setNormalizePunctuation] = useState(true);
  const [sessionLabel, setSessionLabel] = useState("");
  const [submittingCountry, setSubmittingCountry] = useState("");
  const [version, setVersion] = useState("v1");
  const [formatted, setFormatted] = useState<{ blob: Blob; filename: string } | null>(null);
  const [showPages, setShowPages] = useState(false);
  // What the user typed in the country fields: splitting on every keystroke
  // dropped a separator or space typed at the end ("法国，" → "法国").
  const [countryDrafts, setCountryDrafts] = useState({ sponsors: "", signatories: "" });
  const diagnostic = useMemo(() => model ? buildDiagnosticReport(model, validations) : null, [model, validations]);
  const treaty = isTreaty(documentType);
  // A draft resolution keeps the uploaded file's name, so session, country and version are not asked for.
  const keepsSourceName = documentType === "draft-resolution";
  const countryReview = useMemo(() => {
    // Treaty parties are written into the signature block as recognized; no country-name expansion.
    if (!model || isTreaty(model.document_type)) return null;
    const fields = ["country", "sponsors", "signatories"] as const;
    return { changes: fields.flatMap(key => {
      const values = key === "country" ? [model.country] : model[key];
      const plan = planCountries(values, model.language, preserveOrder);
      return [...plan.resolutions.filter(item => item.changed).map(item => `${item.input} → ${item.display}`),
        ...(plan.removedDuplicates ? [`${key === "sponsors" ? "起草国" : "附议国"}将按国家标识合并 ${plan.removedDuplicates} 个重复项`] : [])];
    }), warnings: countryWarnings([model.country, ...model.sponsors, ...model.signatories], model.language) };
  }, [model, preserveOrder]);

  const selectedType = DOCUMENT_TYPES.find((item) => item.id === documentType)!;
  const clauses = useMemo(
    () => model ? [...model.preambulatory_clauses, ...model.operative_clauses, ...model.body_clauses].sort((a, b) => a.paragraph_index - b.paragraph_index) : [],
    [model]
  );

  function resetForType(type: DocumentType) {
    operationRef.current += 1;
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
    setDocumentType(type);
    setFile(null);
    setModel(null);
    setValidations([]);
    setStage("upload");
    setError("");
    setFormatted(null);
    setShowPages(false);
  }

  function acceptFile(nextFile?: File) {
    if (!nextFile) return;
    resetForType(documentType);
    if (!nextFile.name.toLowerCase().endsWith(".docx")) {
      setError("请上传 .docx 文件。旧版 .doc、PDF 和纯文本将在后续版本支持。");
      return;
    }
    if (nextFile.size > MAX_UPLOAD) {
      setError("文件超过 20 MB，请精简图片后重试。");
      return;
    }
    setFile(nextFile);
    setModel(null);
    setValidations([]);
    setStage("upload");
    setError("");
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    acceptFile(event.dataTransfer.files[0]);
  }

  async function parseDocument() {
    if (!file) return;
    const operation = ++operationRef.current;
    setBusy(true);
    setError("");
    setModel(null);
    setFormatted(null);
    setValidations([]);
    setStage("upload");
    setShowPages(false);
    try {
      let body: Model;
      if (API_URL) {
        const form = new FormData();
        form.append("file", file);
        const response = await fetch(`${API_URL}/api/parse/${documentType}`, { method: "POST", body: form, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!response.ok) throw new Error(await readError(response, "文件识别失败。"));
        body = await response.json() as Model;
      } else {
        const content = await file.arrayBuffer();
        if (operation !== operationRef.current) return;
        body = parseDocxInBrowser(content, documentType);
      }
      if (operation !== operationRef.current) return;
      setModel(body);
      setCountryDrafts({ sponsors: (body.sponsors || []).join("，"), signatories: (body.signatories || []).join("，") });
      setSubmittingCountry(body.country || body.sponsors?.[0] || "");
      setStage("review");
    } catch (reason) {
      if (operation !== operationRef.current) return;
      setError(reason instanceof Error ? reason.message : "文件识别失败，请检查 DOCX 后重试。");
    } finally {
      if (operation === operationRef.current) setBusy(false);
    }
  }

  /** A result built from values the user has since changed is never delivered. */
  function discardPending() {
    if (busy) { operationRef.current += 1; setBusy(false); }
    setFormatted(null);
    setValidations([]);
    if (model) setStage("review");
  }

  function updateModel<K extends keyof Model>(key: K, value: Model[K]) {
    discardPending();
    setModel((current) => current ? { ...current, [key]: value } : current);
  }

  function updateCountries(key: "sponsors" | "signatories", text: string) {
    setCountryDrafts((current) => ({ ...current, [key]: text }));
    updateModel(key, splitCountryInput(text));
  }

  async function formatAndDownload() {
    if (!file || !model) return;
    const operation = ++operationRef.current;
    setBusy(true);
    setError("");
    try {
      if (!API_URL) {
        const content = await file.arrayBuffer();
        if (operation !== operationRef.current) return;
        const result = formatDocxInBrowser(content, model, keepsSourceName
          ? { sessionLabel: "", submittingCountry: "", version: "", normalizePunctuation, preserveCountryOrder: preserveOrder, sourceName: file.name }
          : { sessionLabel, submittingCountry, version, normalizePunctuation, preserveCountryOrder: preserveOrder, sourceName: file.name });
        if (operation !== operationRef.current) return;
        setValidations(result.validations);
        setFormatted({ blob: result.blob, filename: result.filename });
        download(result.blob, result.filename);
        setStage("done");
        return;
      }
      const overrides = {
        language: model.language,
        title: model.title,
        committee: model.committee,
        topic: model.topic,
        delegate: model.delegate,
        country: model.country,
        sponsors: model.sponsors,
        signatories: model.signatories,
      };
      const form = new FormData();
      form.append("file", file);
      form.append("overrides_json", JSON.stringify(overrides));
      form.append("preserve_country_order", String(preserveOrder));
      form.append("normalize_punctuation", String(normalizePunctuation));
      form.append("session_label", keepsSourceName ? "" : sessionLabel);
      form.append("submitting_country", keepsSourceName ? "" : submittingCountry);
      form.append("version", keepsSourceName ? "" : version);
      const response = await fetch(`${API_URL}/api/format/${documentType}`, { method: "POST", body: form, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (operation !== operationRef.current) return;
      if (!response.ok) {
        const copy = response.clone();
        let body: { detail?: { validations?: Validation[] } } | null = null;
        try { body = await copy.json() as { detail?: { validations?: Validation[] } }; } catch { /* response was not JSON */ }
        if (operation !== operationRef.current) return;
        if (body?.detail?.validations) setValidations(body.detail.validations);
        throw new Error(await readError(response, "格式化失败，请重试；若仍失败，请保留原文件并反馈。"));
      }
      const blob = await response.blob();
      if (operation !== operationRef.current) return;
      const filename = getDownloadName(response.headers.get("Content-Disposition"));
      setValidations(decodeHeader(response.headers.get("X-PKUNMUN-Validation")));
      setFormatted({ blob, filename });
      download(blob, filename);
      setStage("done");
    } catch (reason) {
      if (operation !== operationRef.current) return;
      setError(reason instanceof Error ? reason.message : "格式化失败。");
    } finally {
      if (operation === operationRef.current) setBusy(false);
    }
  }

  return (
    <main>
      <header className="siteHeader">
        <a className="brand" href="#top" aria-label="回到首页">
          <span className="seal" aria-hidden="true">P</span>
          <span><b>PKUNMUN <span className="brandYear">2026</span></b><small>DOCUMENT STUDIO</small></span>
        </a>
        <div className="headerMeta"><span className="statusDot" />{API_URL ? "服务端处理 · 文件将发送至配置的排版服务" : "浏览器本地处理 · 内容不上传云端"}</div>
      </header>

      <section className="hero" id="top">
        <div className="heroCopy">
          <div className="eyebrow">ACADEMIC DOCUMENTS / 学术文件</div>
          <h1>让表达，<em>井然有序。</em></h1>
          <p>把内容交给你，把格式交给系统。选择文件类型，上传原稿，开启排版。</p>
        </div>
        <div className="principles">
          <span>保留原文内容</span><span>可编辑 DOCX</span><span>生成前后校验</span>
        </div>
      </section>

      <section className="workspace" aria-label="排版工作区">
        <div className="stepper" aria-label="处理进度">
          {[
            ["01", "选择类型"], ["02", "上传原稿"], ["03", "确认识别"], ["04", "生成下载"],
          ].map(([number, label], index) => {
            const active = stage === "upload" ? index <= (file ? 1 : 0) : stage === "review" ? index <= 2 : true;
            return <div className={active ? "step active" : "step"} key={number}><span>{number}</span>{label}</div>;
          })}
        </div>

        <div className="intakeGrid">
        <section className="typePanel" aria-label="选择文件类型">
        <div className="sectionLabel"><span>01</span><div><h2>选择文件类型</h2><p>为你的文件匹配排版规则</p></div></div>
        <div className="typeGrid">
          {DOCUMENT_TYPES.map((type) => (
            <button key={type.id} type="button" aria-pressed={documentType === type.id} className={documentType === type.id ? "typeCard selected" : "typeCard"} onClick={() => resetForType(type.id)}>
              <span className="typeBadge">{type.badge}</span><span><b>{type.zh}</b><small>{type.en}</small></span><span className="radio" />
            </button>
          ))}
        </div>

        </section>
        <section className="uploadPanel" aria-label="上传文件">
        <div className="sectionLabel uploadLabel"><span>02</span><div><h2>上传你的原稿</h2><p>格式交给系统，内容仍由你掌握</p></div></div>
        <div
          className={`dropzone ${dragging ? "dragging" : ""} ${file ? "hasFile" : ""}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          aria-label={file ? `重新选择文件，当前为 ${file.name}` : "选择或拖入 DOCX 文件"}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inputRef.current?.click(); } }}
        >
          <input ref={inputRef} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => acceptFile(event.target.files?.[0])} />
          <div className="fileGlyph" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M9 4h10l6 6v17H9a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z"/><path d="M19 4v7h6M12 17h7M12 22h7"/></svg></div>
          {file ? <><h3>{file.name}</h3><p>{(file.size / 1024).toFixed(1)} KB · 点击可重新选择</p><span className="uploadHint">文件已就绪</span></> : <><h3>将文件拖到这里</h3><p>或 <span className="browseLink">浏览本地文件</span></p><span className="uploadHint">DOCX 格式 · 最大 20 MB</span></>}
        </div>
        {error && <div className="errorBox" role="alert">{error}</div>}
        <div className="actionRow">
          <span>当前类型 <b>{selectedType.zh}</b></span>
          <button className="primaryButton" type="button" disabled={!file || busy} onClick={parseDocument}>{busy ? "正在识别…" : "识别文件结构"}<span>→</span></button>
        </div>

        </section>
        </div>
        <TemplatePanel key={documentType} type={documentType} onGenerated={download} />
        {model && (
          <section className="reviewSection">
            <div className="sectionLabel"><span>03</span><div><h2>确认识别结果</h2><p>无法可靠判断的字段只提示，由你确认后再生成。</p></div></div>
            {countryReview && (countryReview.changes.length > 0 || countryReview.warnings.length > 0) && <div className="countryReview" aria-live="polite">
              <p>国家字段将在生成时自动使用正式全称，无需逐项填写（UNTERM 核对：{COUNTRY_DATA_DATE}）。正文不会替换；复杂字段保留原样。</p>
              {countryReview.changes.map((detail, index) => <p key={`change-${index}`}>{detail}</p>)}
              {countryReview.warnings.map((detail, index) => <p className="countryWarning" key={`warning-${index}`}>{detail}</p>)}
            </div>}
            <div className="formGrid">
              <label>语言<select value={model.language} onChange={(e) => updateModel("language", e.target.value as "zh" | "en")}><option value="zh">中文</option><option value="en">English</option></select></label>
              {treaty && <label className="wide">签署方（逗号分隔，签字栏按此生成）<input value={countryDrafts.sponsors} onChange={(e) => updateCountries("sponsors", e.target.value)} /></label>}
              {!treaty && <><label>委员会<input value={model.committee} onChange={(e) => updateModel("committee", e.target.value)} /></label>
              <label>议题<input value={model.topic} onChange={(e) => updateModel("topic", e.target.value)} /></label></>}
              {documentType === "position-paper" && <><label>国家 / 席位<input value={model.country} onChange={(e) => updateModel("country", e.target.value)} /></label><label>代表<input value={model.delegate} onChange={(e) => updateModel("delegate", e.target.value)} /></label></>}
              {!treaty && documentType !== "position-paper" && <label className="wide">起草国（逗号分隔）<input value={countryDrafts.sponsors} onChange={(e) => updateCountries("sponsors", e.target.value)} /></label>}
              {!treaty && !["position-paper", "working-paper"].includes(documentType) && <label className="wide">附议国（逗号分隔）<input value={countryDrafts.signatories} onChange={(e) => updateCountries("signatories", e.target.value)} /></label>}
            </div>
            {model.warnings.length > 0 && <div className="warningList"><b>需要确认</b>{model.warnings.map((warning, index) => <p key={index}>△ {warning}</p>)}</div>}
            {diagnostic && <details className="studioTool"><summary>识别依据与诊断报告</summary><p>已识别 {diagnostic.paragraph_count} 个非空段落、{diagnostic.clauses.length} 个正文或条款。结构校验：{diagnostic.structure_status === "checked" ? "已检查" : "尚未执行"}；视觉核验：尚未执行。规则置信值不是格式正确率。</p>
              {diagnostic.missing_fields.length > 0 && <p>待确认字段：{diagnostic.missing_fields.map(item => item.label).join("、")}</p>}
              <div className="diagnosticTable"><table><thead><tr><th>原稿段落</th><th>角色 / 层级</th><th>识别依据</th></tr></thead><tbody>{diagnostic.clauses.map((clause, index) => <tr key={index}><td>{clause.paragraph}</td><td>{clause.role} / {clause.level + 1}</td><td>{clause.reason}<small>{clause.text.slice(0, 100)}</small></td></tr>)}</tbody></table></div>
              <button className="secondaryButton" type="button" onClick={() => download(new Blob([JSON.stringify(diagnostic, null, 2)], { type: "application/json" }), "Munword_诊断报告.json")}>下载诊断报告</button><small>报告包含原稿文字，只保存到你的电脑。</small>
            </details>}
            <div className="pagePreviewTools"><button className="secondaryButton" type="button" onClick={() => setShowPages(!showPages)}>{showPages ? "收起页面预览" : "查看实际 DOCX 页面"}</button>{formatted && <button className="secondaryButton" type="button" onClick={() => download(formatted.blob, formatted.filename)}>再次下载成稿</button>}<p>本地 HTML 预览，不发送文件。字体和分页以 Word / WPS 为准；成稿显示上一次生成的版本。</p></div>
            {showPages && file && <div className="docxPreviewGrid"><DocxPreview blob={file} label="原稿页面" />{formatted ? <DocxPreview blob={formatted.blob} label="生成后的 DOCX 页面" /> : <p>生成文件后，此处显示成稿页面。修改字段后请重新生成。</p>}</div>}

            <div className="previewHeader"><div><span>识别摘要 / 非页面排版</span><h3>结构预览</h3></div><small>实际字号、编号和签名空间请查看上方 DOCX 页面</small></div>
            <div className="previewGrid">
              <article className="paper original"><div className="paperTop"><b>原稿文本</b><span>{model.paragraphs.filter(Boolean).length} 段</span></div>{model.paragraphs.filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</article>
              <article className="paper formatted">
                <div className="paperTop"><b>格式化结构</b><span>PKUNMUN 2026</span></div>
                <h4>{model.title || selectedType.zh}</h4>
                {model.committee && <p><strong>{model.language === "zh" ? "委员会：" : "Committee: "}</strong>{model.committee}</p>}
                {model.topic && <p><strong>{model.language === "zh" ? "议题：" : "Topic: "}</strong>{model.topic}</p>}
                {model.country && <p><strong>{model.language === "zh" ? "国家/席位：" : "Country: "}</strong>{model.country}</p>}
                {model.sponsors.length > 0 && <p><strong>{treaty ? (model.language === "zh" ? "签署方：" : "Parties: ") : model.language === "zh" ? "起草国：" : "Sponsors: "}</strong><em>{model.sponsors.join(model.language === "zh" ? "；" : "; ")}</em></p>}
                {model.signatories.length > 0 && <p><strong>{model.language === "zh" ? "附议国：" : "Signatories: "}</strong><em>{model.signatories.join(model.language === "zh" ? "；" : "; ")}</em></p>}
                <div className="clausePreview">{clauses.map((clause, index) => <p className={`clause level${clause.level} ${clause.kind}`} key={`${clause.paragraph_index}-${index}`}><span>{clause.kind === "preambulatory" ? "P" : clause.kind === "operative" ? "O" : "·"}</span>{clause.text}<small>{Math.round(clause.confidence * 100)}%</small></p>)}</div>
              </article>
            </div>

            <div className="generationPanel">
              <div className="options">
                {keepsSourceName ? <p className="sourceName">成稿文件名沿用上传的原文件名：<b>{file?.name}</b></p> : <>
                <label>提交会期<input placeholder="例如：第三会期 / S3" value={sessionLabel} onChange={(e) => { discardPending(); setSessionLabel(e.target.value); }} /></label>
                <label>{treaty ? "文件名中的签署方" : "提交国家"}<input placeholder="用于文件名" value={submittingCountry} onChange={(e) => { discardPending(); setSubmittingCountry(e.target.value); }} /></label>
                <label>版本号<input value={version} onChange={(e) => { discardPending(); setVersion(e.target.value); }} /></label></>}
                {!treaty && <><label className="check"><input type="checkbox" checked={normalizePunctuation} onChange={(e) => { discardPending(); setNormalizePunctuation(e.target.checked); }} /><span>按规则规范条款末尾标点</span></label>
                <label className="check"><input type="checkbox" checked={preserveOrder} onChange={(e) => { discardPending(); setPreserveOrder(e.target.checked); }} /><span>高级：保持国家原顺序</span></label></>}
              </div>
              <button className="primaryButton generate" type="button" disabled={busy} onClick={formatAndDownload}>{busy ? "正在生成…" : "生成并下载 DOCX"}<span>↓</span></button>
            </div>
          </section>
        )}

        {validations.length > 0 && (
          <section className="validationSection">
            <div className="sectionLabel"><span>04</span><div><h2>{stage === "done" ? "成品已下载" : "格式校验结果"}</h2><p>语义不确定项只给出提示，不自动改写。</p></div></div>
            <div className="validationGrid">{validations.map((item, index) => <div className={`validation ${item.status}`} key={`${item.code}-${index}`}><span>{item.status === "pass" ? "✓" : item.status === "warning" ? "△" : "×"}</span><div><b>{item.label}</b>{item.detail && <small>{item.detail}</small>}</div></div>)}</div>
          </section>
        )}
      </section>

      <footer><div><b>PKUNMUN 2026</b><span>文件自动排版系统 · v{release.version}</span></div><p>依据 PKUNMUN 2026 学标示例排版；保留正文、图片、引用与可编辑编号。</p></footer>
    </main>
  );
}
