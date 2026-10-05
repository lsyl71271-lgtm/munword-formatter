import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import policy from "../shared/local-build-policy.json" with { type: "json" };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const inventory = existsSync(".git") ? execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0")
  : Object.keys(JSON.parse(await readFile("PACKAGE-MANIFEST.json", "utf8")).files);
const names = inventory.filter(name => name && !policy.assets.includes(name) && name !== "public/local-build.json" && (policy.sourceFiles.includes(name) || policy.sourceDirectories.some(prefix => name.startsWith(prefix))));
const sourceHashes = async () => Object.fromEntries(await Promise.all(names.sort().map(async name => [name, digest(await readFile(name))])));
const sources = await sourceHashes();
await build({ entryPoints: ["local_web/studio-tools.ts"], outfile: "public/studio-tools.js", bundle: true, minify: true, format: "iife", platform: "browser", target: ["es2022"], legalComments: "inline" });
await build({ entryPoints: ["local_web/main.tsx"], outfile: "public/local-app.js", bundle: true, minify: true, charset: "utf8", format: "iife", platform: "browser", target: ["es2022"], jsx: "automatic", legalComments: "inline", define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_API_URL": '""' } });
// Compile the SAME global stylesheet (including Tailwind's reset/utilities).
// PostCSS is supplied by the pinned Tailwind plugin, not a system installation.
const requirePostcss = createRequire(import.meta.resolve("@tailwindcss/postcss"));
const postcss = requirePostcss("postcss"), tailwind = (await import("@tailwindcss/postcss")).default;
const styles = await postcss([tailwind()]).process(await readFile("app/globals.css", "utf8"), { from: path.resolve("app/globals.css") });
await writeFile("public/local-styles.css", styles.css);
await mkdir("public/licenses", { recursive: true });
for (const [name, source] of Object.entries({ "docx-preview": "node_modules/docx-preview/LICENSE", "docxtemplater": "node_modules/docxtemplater/LICENSE.md", "pizzip": "node_modules/pizzip/LICENSE.markdown" })) {
  await copyFile(source, `public/licenses/${name}.txt`);
}
for (const [owner, dependency, license] of [["docx-preview", "jszip", "LICENSE.markdown"], ["docxtemplater", "@xmldom/xmldom", "LICENSE"]]) {
  const require = createRequire(import.meta.resolve(owner));
  const directory = path.dirname(require.resolve(`${dependency}/package.json`));
  await copyFile(path.join(directory, license), `public/licenses/${dependency.replace("/", "-")}.txt`);
}
await copyFile("node_modules/fflate/LICENSE", "public/licenses/fflate.txt");
for (const name of ["react", "react-dom"]) await copyFile(`node_modules/${name}/LICENSE`, `public/licenses/${name}.txt`);
if (JSON.stringify(sources) !== JSON.stringify(await sourceHashes())) throw new Error("Source changed during build; rebuild before packaging.");
await writeFile("public/local-build.json", JSON.stringify({ schema: 1, version: (await readFile("VERSION", "utf8")).trim(), sources,
  assets: Object.fromEntries(await Promise.all(policy.assets.map(async name => [name, digest(await readFile(name))]))) }, null, 2) + "\n");
