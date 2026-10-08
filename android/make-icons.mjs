// Regenerates the launcher PNGs for Android 5–7.1 (android/res/mipmap-*/ic_launcher.png). Android 8+ uses the
// adaptive icon (res/mipmap-anydpi-v26, vector). Same artwork as the desktop icon: the Munword four-tile mark
// (public/favicon.svg) on a white-to-pale-blue rounded tile. Run when the artwork changes.
//   node android/make-icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const playwright = await import(process.env.MUNWORD_PLAYWRIGHT_MODULE || "playwright");
const { chromium } = playwright.chromium ? playwright : playwright.default;
const mark = readFileSync(path.join(HERE, "..", "public", "favicon.svg"), "utf8").match(/<path[^>]*\/>/g).join("");
// 48 dp grid: a 44 dp tile (Material legacy icon keyline), the mark 28 dp wide in its middle.
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E9F1F9"/></linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="0.8" stdDeviation="0.8" flood-color="#0B2540" flood-opacity="0.25"/></filter>
  </defs>
  <rect x="2" y="2" width="44" height="44" rx="10" fill="url(#tile)" filter="url(#shadow)"/>
  <g transform="translate(9.4 9.4) scale(1.3)">${mark}</g>
</svg>`;
const DENSITIES = [["mdpi", 48], ["hdpi", 72], ["xhdpi", 96], ["xxhdpi", 144], ["xxxhdpi", 192]];
const browser = await chromium.launch({ headless: true, ...(process.env.MUNWORD_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MUNWORD_CHROMIUM_EXECUTABLE } : {}) });
try {
  for (const [density, size] of DENSITIES) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`);
    const dir = path.join(HERE, "res", `mipmap-${density}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "ic_launcher.png"), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`launcher icons: ${DENSITIES.map(([density, size]) => `${density} ${size}px`).join(", ")}`);
