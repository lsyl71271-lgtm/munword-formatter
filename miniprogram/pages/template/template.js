// "从规范模板新建文件" (app/template-panel.tsx): a new document from typed text,
// laid out by the same rules. No AI, nothing uploaded.
const flow = require("../../utils/flow.js");
const files = require("../../utils/files.js");

const app = getApp();
const message = (error, fallback) => (error && error.message) || fallback;

Page({
  data: {
    types: flow.DOCUMENT_TYPES,
    typeIndex: 3,
    languages: flow.LANGUAGES,
    languageIndex: 0,
    fields: [],
    input: flow.emptyTemplateInput(),
    busy: false,
    error: "",
    result: null,
  },
  operation: 0,

  onLoad(query) {
    const index = flow.DOCUMENT_TYPES.findIndex(type => type.id === (query && query.type));
    this.useType(index >= 0 ? index : 3);
  },

  useType(index) {
    this.operation += 1;
    const type = flow.DOCUMENT_TYPES[index].id;
    this.setData({ typeIndex: index, fields: flow.templateFields(type), busy: false, error: "", result: null });
    wx.setNavigationBarTitle({ title: `新建${flow.DOCUMENT_TYPES[index].zh}` });
  },

  onTypeChange(event) { this.useType(Number(event.detail.value)); },

  changed(patch) {
    this.operation += 1;
    this.setData(Object.assign({ busy: false, error: "", result: null }, patch));
  },

  onLanguageChange(event) {
    const index = Number(event.detail.value);
    this.changed({ languageIndex: index, "input.language": flow.LANGUAGES[index].id });
  },

  onInput(event) {
    this.changed({ [`input.${event.currentTarget.dataset.key}`]: event.detail.value });
  },

  onGenerate() {
    if (this.data.busy) return;
    const operation = ++this.operation;
    const type = flow.DOCUMENT_TYPES[this.data.typeIndex].id;
    this.setData({ busy: true, error: "", result: null });
    wx.showLoading({ title: "正在生成…", mask: true });
    new Promise((resolve, reject) => setTimeout(() => {
      try { resolve(app.engine().generateFromTemplate(type, this.data.input)); } catch (error) { reject(error); }
    }, 30)).then(result => result.blob.arrayBuffer().then(buffer => ({ result, buffer })))
      .then(({ result, buffer }) => operation === this.operation ? files.writeOutput(result.filename, buffer) : null)
      .then(saved => { if (saved && operation === this.operation) this.setData({ result: saved }); })
      .catch(error => { if (operation === this.operation) this.setData({ error: message(error, "模板生成失败。") }); })
      .then(() => {
        if (operation === this.operation) this.setData({ busy: false });
        wx.hideLoading();
      });
  },

  onOpenResult() { if (this.data.result) files.openDocx(this.data.result.path).catch(error => this.setData({ error: message(error, "无法打开成稿。") })); },
  onShareResult() {
    const result = this.data.result;
    if (result) files.shareDocx(result.path, result.filename).catch(error => { if (!/cancel/i.test(message(error, ""))) this.setData({ error: message(error, "发送失败。") }); });
  },
  onSaveResult() { if (this.data.result) files.saveDocx(this.data.result.path).catch(error => this.setData({ error: message(error, "保存失败。") })); },
});
