// The four steps of the web page (app/page.tsx) on one mini program page:
// 01 type, 02 file from a chat, 03 check what was recognized (always editable),
// 04 generate, then preview, send or save. Formatting runs on the phone.
const flow = require("../../utils/flow.js");
const files = require("../../utils/files.js");

const app = getApp();
const OPTIONS = () => ({ sessionLabel: "", submittingCountry: "", version: "v1", normalizePunctuation: true, preserveOrder: false });
const message = (error, fallback) => (error && error.message) || fallback;
// Let the loading toast paint before the engine runs synchronously.
const afterPaint = fn => setTimeout(fn, 30);

Page({
  data: {
    types: flow.DOCUMENT_TYPES,
    languages: flow.LANGUAGES,
    documentType: "draft-resolution",
    typeName: "决议草案",
    treaty: false,
    keepsSourceName: true,
    file: null,
    stage: "upload",
    busy: false,
    error: "",
    fields: [],
    values: {},
    languageIndex: 0,
    options: OPTIONS(),
    view: null,
    showDiagnostics: false,
    validations: [],
    result: null,
    countryDate: "",
  },

  // Not in data: the parsed model and the file bytes can be large.
  model: null,
  bytes: null,
  operation: 0,

  onLoad() {
    this.selectType("draft-resolution");
  },

  selectType(type) {
    this.operation += 1;
    this.model = null;
    this.bytes = null;
    this.setData({
      documentType: type, typeName: flow.typeInfo(type).zh, treaty: flow.isTreatyType(type), keepsSourceName: flow.keepsSourceName(type),
      file: null, stage: "upload", busy: false, error: "", fields: [], values: {}, view: null, validations: [], result: null, showDiagnostics: false,
    });
  },

  onSelectType(event) {
    const type = event.currentTarget.dataset.type;
    if (type) this.selectType(type);
  },

  onChooseFile() {
    const type = this.data.documentType;
    files.chooseDocx().then(file => {
      this.selectType(type);
      const problem = flow.checkFile(file, app.engine().MAX_UPLOAD);
      if (problem) { this.setData({ error: problem }); return; }
      this.setData({ file: Object.assign({}, file, { sizeText: flow.sizeText(file.size) }) });
    }).catch(error => {
      if (!/cancel/i.test(message(error, ""))) this.setData({ error: message(error, "未能读取所选文件。") });
    });
  },

  onPreviewOriginal() {
    if (this.data.file) files.openDocx(this.data.file.path).catch(error => this.setData({ error: message(error, "无法预览原稿。") }));
  },

  onParse() {
    const file = this.data.file;
    if (!file || this.data.busy) return;
    const operation = ++this.operation;
    this.model = null;
    this.setData({ busy: true, error: "", view: null, validations: [], result: null, stage: "upload", showDiagnostics: false });
    wx.showLoading({ title: "正在识别…", mask: true });
    files.readArrayBuffer(file.path).then(bytes => new Promise((resolve, reject) => afterPaint(() => {
      try { resolve({ bytes, model: app.engine().parseDocxInBrowser(bytes.slice(0), this.data.documentType) }); } catch (error) { reject(error); }
    }))).then(({ bytes, model }) => {
      if (operation !== this.operation) return;
      this.bytes = bytes;
      this.model = model;
      const languageIndex = model.language === "en" ? 1 : 0;
      this.setData({
        stage: "review", fields: flow.reviewFields(this.data.documentType), languageIndex,
        values: {
          committee: model.committee, topic: model.topic, country: model.country, delegate: model.delegate,
          sponsors: (model.sponsors || []).join("，"), signatories: (model.signatories || []).join("，"),
        },
        // Like the web page: the other options carry over between files; the country for the file name follows the new file.
        options: Object.assign({}, this.data.options, { submittingCountry: model.country || (model.sponsors && model.sponsors[0]) || "" }),
        view: flow.reviewView(app.engine(), model, this.data.options.preserveOrder),
        countryDate: app.engine().COUNTRY_DATA_DATE,
      });
    }).catch(error => {
      if (operation === this.operation) this.setData({ error: message(error, "文件识别失败，请检查 DOCX 后重试。") });
    }).then(() => {
      if (operation === this.operation) this.setData({ busy: false });
      wx.hideLoading();
    });
  },

  /** A result built from values the user has since changed is never kept. */
  discardPending() {
    if (this.data.busy) { this.operation += 1; wx.hideLoading(); }
    this.setData({ busy: false, result: null, validations: [], stage: this.model ? "review" : this.data.stage });
  },

  refreshView() {
    if (this.model) this.setData({ view: flow.reviewView(app.engine(), this.model, this.data.options.preserveOrder) });
  },

  onFieldInput(event) {
    const key = event.currentTarget.dataset.key, text = event.detail.value;
    if (!this.model || !key) return;
    this.discardPending();
    const list = key === "sponsors" || key === "signatories";
    // The text box keeps exactly what was typed; the model gets the split list.
    this.model = Object.assign({}, this.model, { [key]: list ? app.engine().splitCountryNames(text) : text });
    this.setData({ [`values.${key}`]: text });
    this.refreshView();
  },

  onLanguageChange(event) {
    if (!this.model) return;
    const index = Number(event.detail.value);
    this.discardPending();
    this.model = Object.assign({}, this.model, { language: flow.LANGUAGES[index].id });
    this.setData({ languageIndex: index });
    this.refreshView();
  },

  onOptionInput(event) {
    this.discardPending();
    this.setData({ [`options.${event.currentTarget.dataset.key}`]: event.detail.value });
  },

  onOptionSwitch(event) {
    this.discardPending();
    this.setData({ [`options.${event.currentTarget.dataset.key}`]: event.detail.value });
    this.refreshView();
  },

  onToggleDiagnostics() {
    this.setData({ showDiagnostics: !this.data.showDiagnostics });
  },

  onGenerate() {
    if (!this.model || !this.bytes || this.data.busy) return;
    const operation = ++this.operation;
    const options = flow.formatOptions(this.data.documentType, this.data.options, this.data.file.name);
    this.setData({ busy: true, error: "" });
    wx.showLoading({ title: "正在生成…", mask: true });
    new Promise((resolve, reject) => afterPaint(() => {
      try { resolve(app.engine().formatDocxInBrowser(this.bytes.slice(0), this.model, options)); } catch (error) { reject(error); }
    })).then(result => result.blob.arrayBuffer().then(buffer => ({ result, buffer })))
      .then(({ result, buffer }) => {
        if (operation !== this.operation) return null;
        return files.writeOutput(result.filename, buffer).then(saved => {
          if (operation !== this.operation) return;
          this.setData({ validations: flow.validationView(result.validations), result: saved, stage: "done" });
          wx.pageScrollTo({ selector: "#result", duration: 300 });
        });
      })
      .catch(error => { if (operation === this.operation) this.setData({ error: message(error, "格式化失败。") }); })
      .then(() => {
        if (operation === this.operation) this.setData({ busy: false });
        wx.hideLoading();
      });
  },

  onOpenResult() {
    if (this.data.result) files.openDocx(this.data.result.path).catch(error => this.setData({ error: message(error, "无法打开成稿。") }));
  },

  onShareResult() {
    const result = this.data.result;
    if (result) files.shareDocx(result.path, result.filename).catch(error => {
      if (!/cancel/i.test(message(error, ""))) this.setData({ error: message(error, "发送失败。") });
    });
  },

  onSaveResult() {
    if (this.data.result) files.saveDocx(this.data.result.path).catch(error => this.setData({ error: message(error, "保存失败。") }));
  },

  onOpenTemplate() {
    wx.navigateTo({ url: `/pages/template/template?type=${this.data.documentType}` });
  },

  onOpenAbout() {
    wx.navigateTo({ url: "/pages/about/about" });
  },

  onShareAppMessage() {
    return { title: "模联助手：模联文件一键排版", path: "/pages/index/index" };
  },
});
