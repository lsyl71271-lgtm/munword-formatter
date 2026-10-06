// Regenerates desktop/macos/AppIcon.icns (from macos-icon.svg) and desktop/windows/sidebar.bmp
// (from windows-sidebar.svg, needs ImageMagick for the BMP conversion). Run when the artwork changes.
//   node desktop/icons/make-icons.mjs
// Renders with a headless Chromium (Playwright) and writes an ICNS of PNG entries; no macOS tools needed.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const playwright = await import(process.env.MUNWORD_PLAYWRIGHT_MODULE || "playwright");
const { chromium } = playwright.chromium ? playwright : playwright.default;
const svg = readFileSync(path.join(HERE, "macos-icon.svg"), "utf8");
// ICNS PNG slots: type → pixel size.
const SLOTS = [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024], ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512]];
const browser = await chromium.launch({ headless: true, ...(process.env.MUNWORD_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MUNWORD_CHROMIUM_EXECUTABLE } : {}) });
const pngs = new Map();
try {
  for (const size of [...new Set(SLOTS.map(([, s]) => s))]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('width="1024" height="1024"', `width="${size}" height="${size}"`)}</body></html>`);
    pngs.set(size, await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
    await page.close();
  }
  const side = await browser.newPage({ viewport: { width: 328, height: 628 }, deviceScaleFactor: 1 });
  await side.setContent(`<html><body style="margin:0">${readFileSync(path.join(HERE, "windows-sidebar.svg"), "utf8")}</body></html>`);
  writeFileSync(path.join(HERE, "windows-sidebar.png"), await side.screenshot({ clip: { x: 0, y: 0, width: 328, height: 628 } }));
} finally {
  await browser.close();
}
// NSIS needs an uncompressed 24-bit BMP for the welcome/finish sidebar.
execFileSync("convert", [path.join(HERE, "windows-sidebar.png"), "-type", "TrueColor", "BMP3:" + path.join(HERE, "..", "windows", "sidebar.bmp")]);
rmSync(path.join(HERE, "windows-sidebar.png"));
const chunks = SLOTS.map(([type, size]) => {
  const data = pngs.get(size), head = Buffer.alloc(8);
  head.write(type, 0, "ascii"); head.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([head, data]);
});
const body = Buffer.concat(chunks), head = Buffer.alloc(8);
head.write("icns", 0, "ascii"); head.writeUInt32BE(body.length + 8, 4);
writeFileSync(path.join(HERE, "..", "macos", "AppIcon.icns"), Buffer.concat([head, body]));
console.log("AppIcon.icns written:", SLOTS.length, "PNG entries");
