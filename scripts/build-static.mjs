// Public hosting uses the existing offline bundle, never a second UI/engine.
import "./build-local-tools.mjs";
import { readFile, writeFile, mkdir, mkdtemp, copyFile, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const directory = await mkdtemp(".static-site-");
try {
  // Explicit allowlist: never copy source, user documents, env or hosting config.
  const provenance = JSON.parse(await readFile("public/local-build.json", "utf8"));
  const files = {
    "app.js": "public/local-app.js",
    "styles.css": "public/local-styles.css",
    "favicon.svg": "public/favicon.svg",
    ...Object.fromEntries(Object.keys(provenance.assets).filter(name => name.startsWith("public/licenses/")).map(name => [name.slice(7), name])),
  };
  const assets = {};
  for (const [name, source] of Object.entries(files)) {
    const bytes = await readFile(source);
    if (provenance.assets[source] && hash(bytes) !== provenance.assets[source]) throw new Error(`Build asset changed: ${source}`);
    await mkdir(`${directory}/${name.split("/").slice(0, -1).join("/")}`, { recursive: true });
    await copyFile(source, `${directory}/${name}`);
    assets[name] = hash(bytes);
  }
  const html = (await readFile("local_web/index.html", "utf8"))
    .replace('/styles.css"', `/styles.css?v=${assets["styles.css"]}"`)
    .replace('/app.js"', `/app.js?v=${assets["app.js"]}"`)
    .replace("本机单机版与网页版使用同一界面", "本站与本机版使用同一界面");
  await writeFile(`${directory}/index.html`, html);
  await writeFile(`${directory}/version.json`, JSON.stringify({ version: provenance.version, assets }, null, 2) + "\n");
  await writeFile(`${directory}/_headers`, "/*\n  Cache-Control: no-cache\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n");
  // Only replace this known generated directory after a complete successful build.
  await rm("static-site", { recursive: true, force: true });
  await rename(directory, "static-site");
  console.log(`Static Munword ${provenance.version}: ${Object.keys(files).length + 3} files; browser-only processing.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
