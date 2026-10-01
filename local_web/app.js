"use strict";

const DOCUMENT_TYPES = [
  { id: "position-paper", zh: "立场文件", en: "Position Paper", badge: "PP" },
  { id: "working-paper", zh: "工作文件", en: "Working Paper", badge: "WP" },
  { id: "draft-directive", zh: "指令草案", en: "Draft Directive", badge: "DD" },
  { id: "draft-resolution", zh: "决议草案", en: "Draft Resolution", badge: "DR" },
  { id: "friendly-amendment", zh: "友好修正案", en: "Friendly Amendment", badge: "FA" },
  { id: "unfriendly-amendment", zh: "非友好修正案", en: "Unfriendly Amendment", badge: "UA" },
];

const state = {
  documentType: "draft-resolution",
  file: null,
  model: null,
  busy: false,
  operation: 0,
};

const byId = (id) => document.getElementById(id);
const API_URL = location.protocol === "file:" ? "http://127.0.0.1:8000" : "";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function splitCountries(value) {
  return String(value || "").split(/[,，、;；]/).map((item) => item.trim()).filter(Boolean);
}

function selectedType() {
  return DOCUMENT_TYPES.find((item) => item.id === state.documentType);
}

function setError(message) {
  byId("successBox").classList.add("hidden");
  const box = byId("errorBox");
  box.textContent = message || "";
  box.classList.toggle("hidden", !message);
}

function setSuccess(message) {
  byId("errorBox").classList.add("hidden");
  const box = byId("successBox");
  box.textContent = message || "";
  box.classList.toggle("hidden", !message);
}

function setBusy(busy, label) {
  state.busy = busy;
  byId("parseButton").disabled = busy || !state.file;
  byId("generateButton").disabled = busy || !state.model;
  if (label === "parse") byId("parseButton").innerHTML = busy ? "正在识别…" : "识别文件结构 <span>→</span>";
  if (label === "generate") byId("generateButton").innerHTML = busy ? "正在生成…" : "生成并下载 DOCX <span>↓</span>";
}

function updateSteps(stage) {
  const limit = stage === "done" ? 4 : stage === "review" ? 3 : state.file ? 2 : 1;
  [1, 2, 3, 4].forEach((number) => byId(`step${number}`).classList.toggle("active", number <= limit));
}

function renderTypes() {
  window.dispatchEvent(new CustomEvent("munword:type", { detail: { type: state.documentType } }));
  byId("typeGrid").innerHTML = DOCUMENT_TYPES.map((type) => `
    <button type="button" class="typeCard ${type.id === state.documentType ? "selected" : ""}" data-type="${type.id}">
      <span class="typeBadge">${type.badge}</span><span><b>${type.zh}</b><small>${type.en}</small></span><span class="radio"></span>
    </button>`).join("");
  byId("currentZh").textContent = selectedType().zh;
  byId("currentEn").textContent = selectedType().en;
  document.querySelectorAll("[data-type]").forEach((button) => button.addEventListener("click", () => {
    state.operation += 1;
    state.documentType = button.dataset.type;
    state.file = null;
    state.model = null;
    byId("fileInput").value = "";
    byId("fileTitle").textContent = "拖入文件，或点击选择";
    byId("fileMeta").textContent = "支持 .docx · 最大 20 MB";
    byId("dropzone").classList.remove("hasFile");
    byId("reviewSection").classList.add("hidden");
    byId("validationSection").classList.add("hidden");
    setError(""); setSuccess(""); setBusy(false, "parse"); updateSteps("upload"); renderTypes();
  }));
}

function acceptFile(file) {
  if (!file) return;
  state.operation += 1;
  state.file = null;
  state.model = null;
  window.dispatchEvent(new CustomEvent("munword:model", { detail: null }));
  byId("reviewSection").classList.add("hidden");
  byId("validationSection").classList.add("hidden");
  setBusy(false, "parse");
  if (!file.name.toLowerCase().endsWith(".docx")) return setError("请上传 .docx 文件。旧版 .doc、PDF 和纯文本暂不支持。");
  if (file.size > 20 * 1024 * 1024) return setError("文件超过 20 MB，请精简图片后重试。");
  state.file = file;
  state.model = null;
  byId("fileTitle").textContent = file.name;
  byId("fileMeta").textContent = `${(file.size / 1024).toFixed(1)} KB · 点击可重新选择`;
  byId("dropzone").classList.add("hasFile");
  byId("reviewSection").classList.add("hidden");
  byId("validationSection").classList.add("hidden");
  setError(""); setSuccess(""); setBusy(false, "parse"); updateSteps("upload");
}

async function readError(response, fallback) {
  try {
    const body = await response.json();
    if (body?.detail?.message) return body.detail.message;
    if (typeof body?.detail === "string") return body.detail;
    if (Array.isArray(body?.detail)) {
      const messages = body.detail.map((item) => item?.msg).filter(Boolean);
      if (messages.length) return messages.join("；");
    }
  } catch { /* response was not JSON */ }
  return fallback;
}

async function parseDocument() {
  if (!state.file || state.busy) return;
  const operation = ++state.operation;
  setBusy(true, "parse"); setError(""); setSuccess("");
  try {
    const form = new FormData();
    form.append("file", state.file);
    const response = await fetch(`${API_URL}/api/parse/${state.documentType}`, { method: "POST", body: form });
    if (operation !== state.operation) return;
    if (!response.ok) throw new Error(await readError(response, "文件识别失败。"));
    const model = await response.json();
    if (operation !== state.operation) return;
    state.model = model;
    byId("submittingCountry").value = state.model.country || state.model.sponsors?.[0] || "";
    renderReview();
    byId("reviewSection").classList.remove("hidden");
    updateSteps("review");
    byId("reviewSection").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    if (operation !== state.operation) return;
    const localHint = location.protocol === "file:" ? "请双击“PKUNMUN 2026 文件排版系统”应用图标启动。" : "本机排版引擎暂时无法响应，请重新双击应用图标。";
    setError(error instanceof TypeError ? localHint : error.message);
  } finally { if (operation === state.operation) setBusy(false, "parse"); }
}

function field(label, id, value, wide = false) {
  return `<label class="${wide ? "wide" : ""}">${label}<input id="${id}" value="${escapeHtml(value)}"></label>`;
}

function renderReview() {
  const model = state.model;
  let fields = `<label>语言<select id="modelLanguage"><option value="zh" ${model.language === "zh" ? "selected" : ""}>中文</option><option value="en" ${model.language === "en" ? "selected" : ""}>English</option></select></label>`;
  fields += field("委员会", "modelCommittee", model.committee);
  fields += field("议题", "modelTopic", model.topic);
  if (state.documentType === "position-paper") {
    fields += field("国家 / 席位", "modelCountry", model.country);
    fields += field("代表", "modelDelegate", model.delegate);
  } else {
    fields += field("起草国（逗号分隔）", "modelSponsors", (model.sponsors || []).join("，"), true);
  }
  if (!["position-paper", "working-paper"].includes(state.documentType)) fields += field("附议国（逗号分隔）", "modelSignatories", (model.signatories || []).join("，"), true);
  byId("formGrid").innerHTML = fields;

  const bindings = {
    modelLanguage: ["language", (value) => value], modelCommittee: ["committee", (value) => value], modelTopic: ["topic", (value) => value],
    modelCountry: ["country", (value) => value], modelDelegate: ["delegate", (value) => value],
    modelSponsors: ["sponsors", splitCountries], modelSignatories: ["signatories", splitCountries],
  };
  Object.entries(bindings).forEach(([id, [key, transform]]) => {
    const element = byId(id);
    if (element) element.addEventListener("input", () => { state.model[key] = transform(element.value); renderPreviews(); });
  });

  const warnings = model.warnings || [];
  byId("warningList").classList.toggle("hidden", warnings.length === 0);
  byId("warningList").innerHTML = warnings.length ? `<b>需要确认</b>${warnings.map((item) => `<p>△ ${escapeHtml(item)}</p>`).join("")}` : "";
  renderPreviews();
}

function renderPreviews() {
  const model = state.model;
  if (!model) return;
  window.dispatchEvent(new CustomEvent("munword:model", { detail: { model, file: state.file } }));
  const paragraphs = (model.paragraphs || []).filter(Boolean);
  byId("originalPreview").innerHTML = `<div class="paperTop"><b>原稿文本</b><span>${paragraphs.length} 段</span></div>${paragraphs.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}`;
  const clauses = [...(model.preambulatory_clauses || []), ...(model.operative_clauses || []), ...(model.body_clauses || [])].sort((a, b) => a.paragraph_index - b.paragraph_index);
  let formatted = `<div class="paperTop"><b>格式化结构</b><span>PKUNMUN 2026</span></div><h4>${escapeHtml(model.title || selectedType().zh)}</h4>`;
  const zh = model.language === "zh";
  if (model.committee) formatted += `<p><strong>${zh ? "委员会：" : "Committee: "}</strong>${escapeHtml(model.committee)}</p>`;
  if (model.topic) formatted += `<p><strong>${zh ? "议题：" : "Topic: "}</strong>${escapeHtml(model.topic)}</p>`;
  if (model.country) formatted += `<p><strong>${zh ? "国家/席位：" : "Country: "}</strong>${escapeHtml(model.country)}</p>`;
  if (model.sponsors?.length) formatted += `<p><strong>${zh ? "起草国：" : "Sponsors: "}</strong><em>${escapeHtml(model.sponsors.join(zh ? "；" : "; "))}</em></p>`;
  if (model.signatories?.length) formatted += `<p><strong>${zh ? "附议国：" : "Signatories: "}</strong><em>${escapeHtml(model.signatories.join(zh ? "；" : "; "))}</em></p>`;
  formatted += `<div class="clausePreview">${clauses.map((clause) => `<p class="clause level${Number(clause.level) || 0} ${escapeHtml(clause.kind)}"><span>${clause.kind === "preambulatory" ? "P" : clause.kind === "operative" ? "O" : "·"}</span>${escapeHtml(clause.text)}<small>${Math.round((clause.confidence || 0) * 100)}%</small></p>`).join("")}</div>`;
  byId("formattedPreview").innerHTML = formatted;
}

function decodeHeader(value) {
  if (!value) return [];
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return []; }
}

function downloadName(disposition) {
  const match = disposition?.match(/filename\*=UTF-8''([^;]+)/i);
  return match ? decodeURIComponent(match[1]) : "PKUNMUN2026_格式化文件.docx";
}

function renderValidations(items, done) {
  byId("validationTitle").textContent = done ? "成品已下载" : "格式校验结果";
  byId("validationGrid").innerHTML = (items || []).map((item) => `<div class="validation ${escapeHtml(item.status)}"><span>${item.status === "pass" ? "✓" : item.status === "warning" ? "△" : "×"}</span><div><b>${escapeHtml(item.label)}</b>${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ""}</div></div>`).join("");
  byId("validationSection").classList.toggle("hidden", !items?.length);
}

async function formatAndDownload() {
  if (!state.file || !state.model || state.busy) return;
  const operation = ++state.operation;
  setBusy(true, "generate"); setError(""); setSuccess("");
  try {
    const model = state.model;
    const overrides = { language:model.language, title:model.title, committee:model.committee, topic:model.topic, delegate:model.delegate, country:model.country, sponsors:model.sponsors, signatories:model.signatories };
    const form = new FormData();
    form.append("file", state.file);
    form.append("overrides_json", JSON.stringify(overrides));
    form.append("preserve_country_order", String(byId("preserveOrder").checked));
    form.append("normalize_punctuation", String(byId("normalizePunctuation").checked));
    form.append("session_label", byId("sessionLabel").value);
    form.append("submitting_country", byId("submittingCountry").value);
    form.append("version", byId("version").value || "v1");
    const response = await fetch(`${API_URL}/api/format/${state.documentType}`, { method:"POST", body:form });
    if (operation !== state.operation) return;
    if (!response.ok) {
      const copy = response.clone();
      let body = null; try { body = await copy.json(); } catch { /* ignore */ }
      if (body?.detail?.validations) renderValidations(body.detail.validations, false);
      throw new Error(await readError(response, "格式化失败，请重试；若仍失败，请保留原文件并反馈。"));
    }
    const blob = await response.blob();
    if (operation !== state.operation) return;
    const filename = downloadName(response.headers.get("Content-Disposition"));
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    renderValidations(decodeHeader(response.headers.get("X-PKUNMUN-Validation")), true);
    window.dispatchEvent(new CustomEvent("munword:model", { detail: { model, file: state.file, output: blob, validations: decodeHeader(response.headers.get("X-PKUNMUN-Validation")) } }));
    setSuccess(`已生成并开始下载：${filename}`); updateSteps("done");
    byId("validationSection").scrollIntoView({ behavior:"smooth", block:"start" });
  } catch (error) { if (operation === state.operation) setError(error instanceof TypeError ? "本机排版引擎暂时无法响应，请重新双击应用图标。" : error.message); }
  finally { if (operation === state.operation) setBusy(false, "generate"); }
}

async function checkEngine() {
  const element = byId("engineState");
  try {
    const response = await fetch(`${API_URL}/api/health`, { cache:"no-store" });
    if (!response.ok) throw new Error();
    element.querySelector("strong").textContent = "本机引擎已连接";
    element.classList.remove("offline");
  } catch {
    element.querySelector("strong").textContent = "本机引擎未连接";
    element.classList.add("offline");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  renderTypes(); updateSteps("upload"); checkEngine();
  const input = byId("fileInput"); const dropzone = byId("dropzone");
  dropzone.addEventListener("click", () => input.click());
  dropzone.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) input.click(); });
  input.addEventListener("change", () => acceptFile(input.files?.[0]));
  ["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.remove("dragging"); }));
  dropzone.addEventListener("drop", (event) => acceptFile(event.dataTransfer.files?.[0]));
  byId("parseButton").addEventListener("click", parseDocument);
  byId("generateButton").addEventListener("click", formatAndDownload);
});
