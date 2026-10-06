/* ES5 bootstrap: older default browsers receive useful guidance, not a blank page. */
(function () {
  "use strict";
  var supported = window.CSS && CSS.supports("color", "oklch(50% 0.1 120)") &&
    window.TextEncoder && window.TextDecoder && window.Promise && window.fetch &&
    window.Blob && Blob.prototype.arrayBuffer && window.URL && URL.createObjectURL;
  var firefox = /Firefox\/(\d+)/.exec(navigator.userAgent);
  var chromium = /(?:Chrome|Edg)\/(\d+)/.exec(navigator.userAgent);
  var safari = /Version\/(\d+)\.(\d+).*Safari\//.exec(navigator.userAgent);
  if ((firefox && Number(firefox[1]) < 128) || (chromium && Number(chromium[1]) < 111) ||
      (!chromium && safari && (Number(safari[1]) < 16 || (Number(safari[1]) === 16 && Number(safari[2]) < 4)))) supported = false;
  if (!supported) {
    document.getElementById("root").textContent = "浏览器版本较旧，无法完整运行排版和预览。请使用 Edge/Chrome 111+、Firefox 128+ 或 Safari 16.4+，在该浏览器中打开当前地址。Windows 不支持 Internet Explorer。安装包已包含全部排版组件，不需要安装 Python 或 Node。";
    return;
  }
  var bar = document.createElement("div");
  bar.style.cssText = "padding:8px 18px;background:#f3f4f6;color:#20252b;font:13px sans-serif;display:flex;gap:14px;align-items:center;justify-content:space-between";
  var label = document.createElement("span");
  label.textContent = "本机离线模式 · 文件不会上传 · 关闭网页后程序最多保留 30 分钟";
  var quit = document.createElement("button");
  quit.textContent = "退出本机程序";
  quit.style.cssText = "cursor:pointer;border:1px solid #ccc;padding:4px 10px;background:white;border-radius:4px;white-space:nowrap";
  quit.onclick = function () {
    if (!window.confirm("退出将关闭此电脑上所有 Munword 页面使用的本机服务。请先保存成品。是否退出？")) return;
    fetch("/__desktop/quit", {method:"POST", headers:{"X-Munword-Action":"quit"}, credentials:"same-origin"}).then(function (response) {
      if (!response.ok) throw new Error("exit");
      label.textContent = "本机程序已退出。下次使用请双击 Munword 应用。";
      quit.disabled = true;
    }).catch(function () { label.textContent = "服务已断开，可关闭网页；如需继续使用，请重新打开 Munword 应用。"; });
  };
  bar.appendChild(label); bar.appendChild(quit); document.body.insertBefore(bar, document.body.firstChild);
  var ping = function () { fetch("/__desktop/ping", {credentials:"same-origin"}).catch(function () { /* Browser can keep/save the in-memory result after stopping. */ }); };
  ping(); window.setInterval(ping, 15000);
  var app = document.createElement("script"); app.src = "/app.js";
  app.onerror = function () { label.textContent = "离线界面加载失败，请退出并重新打开应用，或重新安装完整安装包。"; };
  document.body.appendChild(app);
}());
