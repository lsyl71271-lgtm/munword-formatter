// Inlined into the Android page before the app loads (ES5: it must run in any WebView, even one too old for the
// app, without breaking the notice). The Android activity exposes window.MunwordAndroid; elsewhere this does nothing.
//
// Saving: the shared page downloads by clicking an <a download href="blob:..."> link, which an Android WebView
// cannot save. The blobs behind object URLs are remembered, and a click on such a link hands the bytes to the
// activity instead (read with FileReader: no fetch, which the page's Content-Security-Policy forbids), in base64
// chunks, and the activity writes them to the Downloads folder.
//
// Opening: a .docx opened from another app ("open with" / share, e.g. from WeChat) is kept by the activity, which
// then calls window.__munwordReceive(). The file is read back in chunks and given to the page's own file input,
// exactly as if it had been chosen there; recognition and step 03 stay the user's.
(function () {
  var bridge = window.MunwordAndroid;
  if (!bridge) return;
  var CHUNK = 1048576; // base64 characters per call: a multiple of 4, so every chunk decodes on its own
  var blobs = {};
  // How far the last hand-overs got (counts and the last error only), for diagnosing a WebView that misbehaves.
  var status = window.__munwordBridge = { links: 0, reads: 0, sent: 0, error: "" };
  var createObjectURL = URL.createObjectURL, revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = function (object) {
    var url = createObjectURL.call(URL, object);
    if (typeof Blob !== "undefined" && object instanceof Blob) blobs[url] = object;
    return url;
  };
  URL.revokeObjectURL = function (url) {
    delete blobs[url];
    return revokeObjectURL.call(URL, url);
  };

  function save(blob, name) {
    var reader = new FileReader();
    reader.onload = function () {
      status.reads++;
      try {
        var data = String(reader.result), base64 = data.slice(data.indexOf(",") + 1);
        var id = bridge.begin(name, blob.type || "application/octet-stream", blob.size);
        for (var offset = 0; offset < base64.length; offset += CHUNK) bridge.append(id, base64.slice(offset, offset + CHUNK));
        bridge.finish(id);
        status.sent++;
      } catch (error) {
        status.error = String(error && error.message || error);
        try { bridge.failed(name, status.error); } catch (ignored) { /* the bridge itself is gone */ }
      }
    };
    reader.onerror = function () {
      status.error = String(reader.error && reader.error.message || "read error");
      bridge.failed(name, status.error);
    };
    reader.readAsDataURL(blob);
  }

  var click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    // The page assigns the object URL itself; older engines may give .href back in another spelling.
    var blob = blobs[this.getAttribute("href")] || blobs[this.href];
    if (blob && this.hasAttribute("download")) {
      status.links++;
      save(blob, this.getAttribute("download") || "PKUNMUN2026.docx");
      return;
    }
    return click.apply(this, arguments);
  };

  // The page resets the chosen file whenever a document type is picked (type first, then file). A file opened from
  // another app arrives before the user has picked its type, so it is kept and handed to the page again after
  // each type change, until the user chooses a different file themselves.
  // Every newly opened file and every file the user picks starts a new generation; a hand-over still waiting (for the
  // file input to appear, or for the page to clear its file) belongs to the generation it started in and stops once
  // that is over, so an older file can never replace a newer one. A reload starts this script afresh.
  var held = null, delivering = false, nativeChange = false, generation = 0, timer = null;
  status.generation = 0;
  function later(step, ms) {
    clearTimeout(timer);
    timer = setTimeout(step, ms);
  }
  function newGeneration() {
    clearTimeout(timer);
    timer = null;
    status.generation = ++generation;
  }
  function deliver(file, owner) {
    var attempts = 0;
    (function attempt() {
      if (owner !== generation) return;
      var input = document.querySelector('input[type="file"]');
      if (!input) {
        if (attempts++ < 100) later(attempt, 100);
        return;
      }
      var transfer = new DataTransfer();
      transfer.items.add(file);
      // Older Chromium (69, for one) fires a real change event itself when files are assigned; newer ones do not.
      delivering = true;
      nativeChange = false;
      try {
        input.files = transfer.files;
        if (!nativeChange) input.dispatchEvent(new Event("change", { bubbles: true }));
      } finally {
        delivering = false;
      }
    })();
  }
  // After a type change, wait until the page has actually cleared its file (a slow device may render the reset a
  // little later), then give the kept file back.
  function redeliver(owner, waited) {
    if (!held || owner !== generation) return;
    var cleared = !document.querySelector(".dropzone.hasFile");
    if (cleared || waited >= 3000) deliver(held, owner);
    else later(function () { redeliver(owner, waited + 50); }, 50);
  }
  document.addEventListener("click", function (event) {
    if (!held) return;
    for (var node = event.target; node && node.classList; node = node.parentNode) {
      if (node.classList.contains("typeCard")) { redeliver(generation, 0); return; }
    }
  }, true);
  document.addEventListener("change", function (event) {
    if (!event.target || event.target.type !== "file") return;
    if (delivering) nativeChange = true;
    else if (event.isTrusted) { held = null; newGeneration(); } // the user chose another file themselves
  }, true);

  window.__munwordReceive = function () {
    var name = bridge.openedName();
    if (!name) return;
    var size = bridge.openedSize(), parts = [];
    // 786432 bytes per chunk: a multiple of 3, so the activity's base64 pieces need no padding in between.
    for (var offset = 0; offset < size; offset += 786432) {
      var binary = atob(bridge.openedChunk(offset, 786432)), bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      parts.push(bytes);
    }
    bridge.openedDone();
    newGeneration();
    held = new File(parts, name, { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    deliver(held, generation);
  };
})();
