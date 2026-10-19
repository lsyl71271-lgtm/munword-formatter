// The formatting engine (lib/munword-engine.js, ~0.5 MB) is loaded on first use, not at launch.
let engine = null;

App({
  engine() {
    if (!engine) engine = require("./lib/munword-engine.js");
    return engine;
  },
});
