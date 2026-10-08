// Gap in flex containers for WebViews older than Chromium 84, which lay flex items out as if gap were 0. Runs only
// when the loader has set html.no-flex-gap. After every render it gives each flex container's items the space as
// margins: the item after another gets the gap added to its own margin; an item followed by text (which cannot carry
// a margin) gets it on its far side instead. Hidden and absolutely positioned children are skipped, as flex gap
// skips them. Wrapping containers also get the gap between lines. Current WebViews never run this.
(function () {
  var html = document.documentElement;
  if (!/(^|\s)no-flex-gap(\s|$)/.test(html.className)) return;
  // Selectors whose margins are "auto" (filled in by android/build-site.mjs): adding to them would pin them in place.
  var autoMargins = /*AUTO_MARGIN_SELECTORS*/[].join(",");
  var touched = [], scheduled = false, observer;
  var px = function (value) { return parseFloat(value) || 0; };
  var sides = {
    row: ["marginLeft", "marginRight", "marginBottom"],
    "row-reverse": ["marginRight", "marginLeft", "marginBottom"],
    column: ["marginTop", "marginBottom", "marginRight"],
    "column-reverse": ["marginBottom", "marginTop", "marginRight"]
  };

  function apply() {
    scheduled = false;
    observer.disconnect();
    for (var u = touched.length - 1; u >= 0; u--) touched[u][0].style[touched[u][1]] = touched[u][2];
    touched = [];
    var additions = new Map(), all = document.body.getElementsByTagName("*");
    var add = function (element, style, side, amount) {
      if (!amount || (autoMargins && element.matches(autoMargins))) return;
      var entries = additions.get(element) || {};
      if (!(side in entries)) entries[side] = px(style[side]); // read once, before anything is written
      entries[side] += amount;
      additions.set(element, entries);
    };
    for (var i = 0; i < all.length; i++) {
      var container = all[i], style = getComputedStyle(container);
      if (style.display !== "flex" && style.display !== "inline-flex") continue;
      var axis = sides[style.flexDirection] || sides.row, column = /^column/.test(style.flexDirection);
      var rowGap = style.rowGap || style.gridRowGap, columnGap = style.columnGap || style.gridColumnGap;
      var mainGap = px(column ? rowGap : columnGap), crossGap = px(column ? columnGap : rowGap);
      var wrap = style.flexWrap !== "nowrap" && crossGap > 0;
      if (!mainGap && !wrap) continue;
      var items = [];
      for (var node = container.firstChild; node; node = node.nextSibling) {
        if (node.nodeType === 3 && /\S/.test(node.nodeValue)) items.push(null);
        else if (node.nodeType === 1) {
          var itemStyle = getComputedStyle(node);
          if (itemStyle.display !== "none" && itemStyle.position !== "absolute" && itemStyle.position !== "fixed") items.push([node, itemStyle]);
        }
      }
      for (var k = 1; k < items.length; k++) {
        if (items[k]) add(items[k][0], items[k][1], axis[0], mainGap);
        else if (items[k - 1]) add(items[k - 1][0], items[k - 1][1], axis[1], mainGap);
      }
      if (wrap) {
        // Space below every item, taken back from the container so the last line ends where it did.
        for (var w = 0; w < items.length; w++) if (items[w]) add(items[w][0], items[w][1], axis[2], crossGap);
        add(container, style, axis[2], -crossGap);
      }
    }
    // Written only after everything is read, so no reading sees a margin set here.
    additions.forEach(function (entries, element) {
      for (var side in entries) {
        touched.push([element, side, element.style[side]]);
        element.style[side] = entries[side] + "px";
      }
    });
    observe();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(apply);
  }
  function observe() {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "open", "hidden"] });
  }
  observer = new MutationObserver(schedule);
  observe();
  window.addEventListener("resize", schedule);
  schedule();
})();
