// Built-ins the shared page uses that older Android WebViews lack. The Android page is the same source compiled for
// Chromium 69 (esbuild lowers the syntax); these fill in the library functions. Each is defined only when missing,
// non-enumerable like the real one, so a current WebView runs its own native code.
(function () {
  var define = function (target, name, value) {
    if (target && !(name in target)) Object.defineProperty(target, name, { value: value, writable: true, configurable: true, enumerable: false });
  };
  var toLength = function (value) {
    var number = Math.trunc(Number(value)) || 0;
    return Math.min(Math.max(number, 0), Number.MAX_SAFE_INTEGER);
  };
  var relativeIndex = function (self, index) {
    var length = toLength(self.length), position = Math.trunc(Number(index)) || 0;
    if (position < 0) position += length;
    return position < 0 || position >= length ? undefined : self[position];
  };

  define(typeof self !== "undefined" ? self : this, "globalThis", typeof self !== "undefined" ? self : this);

  define(Object, "fromEntries", function (entries) {
    var result = {};
    var iterator = entries[Symbol.iterator]();
    for (var step = iterator.next(); !step.done; step = iterator.next()) result[step.value[0]] = step.value[1];
    return result;
  });
  define(Object, "hasOwn", function (object, key) { return Object.prototype.hasOwnProperty.call(Object(object), key); });

  var findLast = function (predicate, thisArg) {
    for (var i = toLength(this.length) - 1; i >= 0; i--) if (predicate.call(thisArg, this[i], i, this)) return this[i];
    return undefined;
  };
  var findLastIndex = function (predicate, thisArg) {
    for (var i = toLength(this.length) - 1; i >= 0; i--) if (predicate.call(thisArg, this[i], i, this)) return i;
    return -1;
  };
  var at = function (index) { return relativeIndex(this, index); };
  var typed = Object.getPrototypeOf(Int8Array.prototype);
  [Array.prototype, typed].forEach(function (proto) {
    define(proto, "findLast", findLast);
    define(proto, "findLastIndex", findLastIndex);
    define(proto, "at", at);
  });
  define(String.prototype, "at", function (index) { return relativeIndex(String(this), index); });

  define(String.prototype, "replaceAll", function (search, replacement) {
    if (search instanceof RegExp) {
      if (!search.global) throw new TypeError("replaceAll must be called with a global RegExp");
      return String(this).replace(search, replacement);
    }
    // A global RegExp of the escaped text replaces exactly like replaceAll, "$&" patterns and functions included.
    var escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return String(this).replace(new RegExp(escaped, "g"), replacement);
  });

  define(Promise, "allSettled", function (promises) {
    return Promise.all(Array.from(promises, function (promise) {
      return Promise.resolve(promise).then(
        function (value) { return { status: "fulfilled", value: value }; },
        function (reason) { return { status: "rejected", reason: reason }; });
    }));
  });

  // Chromium 76: Blob#arrayBuffer / Blob#text (the page reads the chosen file with arrayBuffer()).
  var read = function (method) {
    return function () {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = function () { reject(reader.error); };
        reader[method](this);
      }.bind(this));
    };
  };
  if (typeof Blob !== "undefined") {
    define(Blob.prototype, "arrayBuffer", read("readAsArrayBuffer"));
    define(Blob.prototype, "text", read("readAsText"));
  }

  if (typeof queueMicrotask !== "function") {
    self.queueMicrotask = function (callback) {
      Promise.resolve().then(callback).catch(function (error) { setTimeout(function () { throw error; }); });
    };
  }

  var replaceChildren = function () {
    while (this.lastChild) this.removeChild(this.lastChild);
    for (var i = 0; i < arguments.length; i++) {
      var node = arguments[i];
      this.appendChild(typeof node === "string" ? document.createTextNode(node) : node);
    }
  };
  [typeof Element !== "undefined" && Element.prototype, typeof Document !== "undefined" && Document.prototype,
    typeof DocumentFragment !== "undefined" && DocumentFragment.prototype].forEach(function (proto) {
    if (proto) define(proto, "replaceChildren", replaceChildren);
  });
})();
