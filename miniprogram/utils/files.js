// File handling with the mini program APIs. Documents stay on the phone: they are
// read from the chat file the user picked and written to the app's own folder.

const OUTPUT_DIR = () => `${wx.env.USER_DATA_PATH}/munword`;

const promisify = (api, options) => new Promise((resolve, reject) => api(Object.assign({}, options, {
  success: resolve,
  fail: error => reject(new Error((error && error.errMsg) || "操作失败")),
})));

/** Pick one .docx from a WeChat chat (the main way students receive files). */
function chooseDocx() {
  return promisify(wx.chooseMessageFile, { count: 1, type: "file", extension: ["docx"] })
    .then(result => {
      const file = result.tempFiles && result.tempFiles[0];
      if (!file) throw new Error("没有选择文件。");
      return { path: file.path, name: file.name, size: file.size };
    });
}

function readArrayBuffer(path) {
  const fs = wx.getFileSystemManager();
  return promisify(fs.readFile.bind(fs), { filePath: path }).then(result => result.data);
}

/** No path separators or characters some phones' file systems refuse. */
const safeName = name => String(name || "Munword.docx").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(-120);

/** Write the formatted document into the app's folder, replacing the previous result. */
function writeOutput(filename, arrayBuffer) {
  const fs = wx.getFileSystemManager();
  const dir = OUTPUT_DIR();
  try { fs.rmdirSync(dir, true); } catch { /* first run: nothing to remove */ }
  try { fs.mkdirSync(dir, true); } catch { /* already there */ }
  const path = `${dir}/${safeName(filename)}`;
  return promisify(fs.writeFile.bind(fs), { filePath: path, data: arrayBuffer }).then(() => ({ path, filename: safeName(filename) }));
}

/** Word preview inside WeChat; its menu offers saving and opening in other apps. */
function openDocx(path) {
  return promisify(wx.openDocument, { filePath: path, fileType: "docx", showMenu: true });
}

/** Send the file back into a chat. */
function shareDocx(path, filename) {
  if (!wx.shareFileMessage) return Promise.reject(new Error("当前微信版本不支持直接发送文件，请先点「预览」，再从右上角菜单转发。"));
  return promisify(wx.shareFileMessage, { filePath: path, fileName: filename });
}

/** Save to disk where the platform allows it (WeChat on Windows and Mac); phones use the preview menu. */
function saveDocx(path) {
  if (!wx.saveFileToDisk) return openDocx(path);
  return promisify(wx.saveFileToDisk, { filePath: path }).catch(() => openDocx(path));
}

module.exports = { chooseDocx, readArrayBuffer, writeOutput, openDocx, shareDocx, saveDocx, safeName };
